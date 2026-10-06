import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { Stock } from './entities/stock.entity';
import { PriceAlert } from './entities/price.alert';
import { CreatePriceAlertDto } from './dto/price-alert.dto';

export interface EodPriceData {
  price: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  marketCap?: number | null;
  priceDate: string;
}

@Injectable()
export class StockPriceService implements OnModuleInit {
  private readonly logger = new Logger(StockPriceService.name);
  private readonly API_KEY = 'hq7Qvui4yAYrWwqY5AglfPBXkmXXyOXL';

  private readonly initialStocks = [
    { symbol: 'MSFT', name: 'Microsoft', industry: 'Technology' },
    { symbol: 'NVDA', name: 'NVIDIA', industry: 'Technology' },
    { symbol: 'LLY', name: 'Eli Lilly', industry: 'Healthcare' },
    { symbol: 'JNJ', name: 'Johnson & Johnson', industry: 'Healthcare' },
    { symbol: 'JPM', name: 'JPMorgan Chase', industry: 'Financials' },
    { symbol: 'V', name: 'Visa', industry: 'Financials' },
    { symbol: 'AMZN', name: 'Amazon', industry: 'Consumer Discretionary' },
    { symbol: 'DIS', name: 'The Walt Disney Company', industry: 'Consumer Discretionary' },
    { symbol: 'XOM', name: 'Exxon Mobil', industry: 'Energy' },
    { symbol: 'CVX', name: 'Chevron', industry: 'Energy' },
  ];

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Stock)
    private readonly stockRepository: Repository<Stock>,
    @InjectRepository(PriceAlert)
    private readonly priceAlertRepository: Repository<PriceAlert>,
  ) {}

  async onModuleInit() {
    this.logger.log('StockPriceService initialized.');
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async createPriceAlert(dto: CreatePriceAlertDto) {
    const alert = this.priceAlertRepository.create(dto);
    return await this.priceAlertRepository.save(alert);
  }

  async getAllAlerts() {
    return await this.priceAlertRepository.find();
  }

  async fetchEodPriceFromMassive(symbol: string): Promise<EodPriceData | null> {
    try {
      const upperSymbol = symbol.toUpperCase();

      // 1. ดึงราคา EOD (Price, Open, High, Low, Volume)
      const priceUrl = `https://api.massive.com/v2/aggs/ticker/${upperSymbol}/prev?adjusted=true&apiKey=${this.API_KEY}`;
      const priceResponse = await firstValueFrom(
        this.httpService.get(priceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }),
      );

      // ชะลอเล็กน้อยเพื่อป้องกัน Rate Limit กับ API Endpoint ที่สอง
      await this.delay(500);

      // 2. ดึงข้อมูลรายละเอียดหุ้น เพื่อเอา Market Cap
      let marketCap: number | null = null;
      try {
        const detailUrl = `https://api.massive.com/v3/reference/tickers/${upperSymbol}?apiKey=${this.API_KEY}`;
        const detailResponse = await firstValueFrom(
          this.httpService.get(detailUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          }),
        );
        const resData = detailResponse.data?.results;
        const calculatedCap = (resData?.weighted_shares_outstanding && priceResponse.data?.results?.[0]?.c)
  ? resData.weighted_shares_outstanding * priceResponse.data.results[0].c
  : null;

marketCap = resData?.market_cap ?? resData?.marketCap ?? calculatedCap;
      } catch (detailErr: any) {
        this.logger.warn(`Could not fetch market_cap for ${symbol}: ${detailErr?.message}`);
      }

      const results = priceResponse.data?.results;
      if (results && results.length > 0) {
        const item = results[0];
        const dateStr = new Date(item.t).toISOString().split('T')[0];

        return {
          price: Number(item.c),
          open: item.o ? Number(item.o) : (item.open ? Number(item.open) : null),
          high: item.h ? Number(item.h) : (item.high ? Number(item.high) : null),
          low: item.l ? Number(item.l) : (item.low ? Number(item.low) : null),
          volume: item.v ? Number(item.v) : (item.volume ? Number(item.volume) : null),
          marketCap: marketCap ? Number(marketCap) : null,
          priceDate: dateStr,
        };
      }
      return null;
    } catch (error: any) {
      const errDetail = error?.response?.data?.error || error?.message;
      this.logger.error(`Error fetching real price for ${symbol}: ${errDetail}`);
      return null;
    }
  }

  async updateAllStockPrices() {
    this.logger.log(`Fetching EOD prices for ${this.initialStocks.length} stocks...`);

    let updatedCount = 0;
    for (const stockInfo of this.initialStocks) {
      const data = await this.fetchEodPriceFromMassive(stockInfo.symbol);

      if (data !== null) {
        await this.stockRepository.upsert(
          {
            symbol: stockInfo.symbol,
            name: stockInfo.name,
            industry: stockInfo.industry,
            eod_price: data.price,
            open: data.open ?? null,
            high: data.high ?? null,
            low: data.low ?? null,
            volume: data.volume ?? null,
            market_cap: data.marketCap ?? null,
            price_date: data.priceDate,
          },
          ['symbol', 'price_date'],
        );

        updatedCount++;
        this.logger.log(
          `[SAVED] ${stockInfo.symbol}: Close=$${data.price} Open=$${data.open} High=$${data.high} Low=$${data.low} Vol=${data.volume} MarketCap=${data.marketCap} | Date: ${data.priceDate}`,
        );

        await this.checkAndTriggerAlerts(stockInfo.symbol, data.price);
      }

      await this.delay(12500);
    }

    return {
      message: 'Stock prices updated/inserted successfully in the same table',
      updated_stocks: updatedCount,
    };
  }

  private async checkAndTriggerAlerts(symbol: string, currentPrice: number) {
    const activeAlerts = await this.priceAlertRepository.find({
      where: {
        symbol: symbol,
        is_triggered: false,
      },
    });

    for (const alert of activeAlerts) {
      if (currentPrice >= alert.target_price) {
        this.logger.warn(
          `🔔 [ALERT TRIGGERED] หุ้น ${symbol} ราคาปัจจุบัน ($${currentPrice}) สูงกว่าหรือเท่ากับราคาเป้าหมาย ($${alert.target_price}) แล้ว!`,
        );

        alert.is_triggered = true;
        await this.priceAlertRepository.save(alert);
      }
    }
  }

  async getAllStocks() {
    return await this.stockRepository.find({
      order: {
        price_date: 'DESC',
        symbol: 'ASC',
      },
    });
  }
}