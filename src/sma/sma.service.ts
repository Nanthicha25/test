import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { PriceAlertEntity } from '../entities/price-alert.entity'; 
import { SmaRecord } from '../entities/sma-record.entity';
import { CalculateSmaDto } from './dto/calculate-sma.dto';

@Injectable()
export class SmaService {
  private readonly logger = new Logger(SmaService.name);

  constructor(
    @InjectRepository(PriceAlertEntity)
    private readonly stockRepository: Repository<PriceAlertEntity>,

    @InjectRepository(SmaRecord)
    private readonly smaRecordRepository: Repository<SmaRecord>,
  ) {}

  // ฟังก์ชันสำหรับ API ขอค่า SMA ล่าสุด 1 รายการ
  async processSmaRequest(dto: CalculateSmaDto) {
    const symbolUpper = dto.symbol.toUpperCase();
    const period = dto.period;

    const stockHistory = await this.stockRepository.find({
      where: {
        symbol: symbolUpper,
        eod_price: Not(IsNull()),
      },
      order: { price_date: 'DESC' },
      take: period,
    });

    if (stockHistory.length < period) {
      throw new BadRequestException({
        error_code: 'INSUFFICIENT_DATA',
        message: `ข้อมูลราคาในระบบมีไม่เพียงพอสำหรับการคำนวณ SMA (${period} วัน)`,
        details: { field: 'period', received_value: period, available_records: stockHistory.length },
      });
    }

    const latestPriceDate = stockHistory[0]?.price_date;
    if (!this.isDataFresh(latestPriceDate)) {
      throw new BadRequestException({
        error_code: 'OUTDATED_DATA',
        message: 'ข้อมูลราคาในระบบเก่าเกินไป ระบบพื้นหลังยังไม่ได้อัปเดตราคาล่าสุด',
        details: { latest_date: latestPriceDate },
      });
    }

    const prices = stockHistory.map((s) => Number(s.eod_price));
    const sum = prices.reduce((acc, curr) => acc + curr, 0);
    const smaValue = Number((sum / period).toFixed(2));

    const formatDateStr = (d: Date | string | null | undefined): string => {
      if (!d) return '';
      if (typeof d === 'string') return d.split('T')[0];
      return new Date(d).toISOString().split('T')[0];
    };

    const newRecord = this.smaRecordRepository.create({
      symbol: symbolUpper,
      period: period,
      smaValue: smaValue,
      dataPointsUsed: prices.length,
      latestDate: formatDateStr(latestPriceDate),
    });
    const savedRecord = await this.smaRecordRepository.save(newRecord);

    return {
      symbol: symbolUpper,
      period: period,
      sma: savedRecord.smaValue,
      sma_value: savedRecord.smaValue,
      data_points_used: prices.length,
      latest_date: savedRecord.latestDate,
      calculated_at: savedRecord.calculatedAt
        ? savedRecord.calculatedAt.toISOString()
        : new Date().toISOString(),
    };
  }

  // ฟังก์ชันช่วย BacktestingService (สร้าง/ดึง Series ย้อนหลัง)
  async getOrGenerateSmaSeries(
    symbol: string,
    period: number,
    priceRecords: PriceAlertEntity[],
  ): Promise<SmaRecord[]> {
    const symbolUpper = symbol.toUpperCase();

    // Helper แปลง String / Date ให้เป็น YYYY-MM-DD
    const formatDateStr = (d: Date | string | null | undefined): string => {
      if (!d) return '';
      if (typeof d === 'string') return d.split('T')[0];
      const dateObj = new Date(d);
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // 1. ดึง Record ทั้งหมดที่มีแล้วใน DB
    const existingRecords = await this.smaRecordRepository.find({
      where: { symbol: symbolUpper, period },
    });

    // เก็บวันที่ที่มีข้อมูลอยู่แล้วใส่ Set เพื่อเช็กความซ้ำซ้อนอย่างรวดเร็ว
    const existingDatesSet = new Set<string>(
      existingRecords
        .map((r) => r.latestDate)
        .filter((d): d is string => Boolean(d)),
    );

    const newSmaEntities: Partial<SmaRecord>[] = [];

    // 2. วนลูปคำนวณเฉพาะช่วงวันที่ที่ยังไม่มีใน DB (Delta Sync)
    for (let i = 0; i < priceRecords.length; i++) {
      if (i >= period - 1) {
        const dateStr = formatDateStr(priceRecords[i].price_date);

        // ถ้ายังไม่มีข้อมูล SMA ของวันนี้นำมาคำนวณและเตรียมบันทึก
        if (dateStr && !existingDatesSet.has(dateStr)) {
          const window = priceRecords.slice(i - period + 1, i + 1);
          const sum = window.reduce((acc, curr) => acc + Number(curr.eod_price ?? 0), 0);
          const smaValue = Number((sum / period).toFixed(2));

          newSmaEntities.push({
            symbol: symbolUpper,
            period,
            smaValue,
            dataPointsUsed: period,
            latestDate: dateStr, 
          });
        }
      }
    }

    // 3. บันทึกเฉพาะข้อมูลแถวใหม่ลง DB
    if (newSmaEntities.length > 0) {
      this.logger.log(`บันทึก SMA (${period}) เพิ่มเติมจำนวน ${newSmaEntities.length} แถวสำหรับ ${symbolUpper}`);
      const createdEntities = this.smaRecordRepository.create(newSmaEntities);
      await this.smaRecordRepository.save(createdEntities);
    }

    // 4. คืนค่าประวัติ SMA ทั้งหมดที่เรียงตามวันที่
    return this.smaRecordRepository.find({
      where: { symbol: symbolUpper, period },
      order: { latestDate: 'ASC' },
    });
  }

  private isDataFresh(latestDate: Date | string, maxGapDays: number = 5): boolean {
    if (!latestDate) return false;
    const today = new Date();
    const latest = new Date(latestDate);
    const diffTime = Math.abs(today.getTime() - latest.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= maxGapDays;
  }
}