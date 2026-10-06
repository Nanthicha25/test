import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { RecoveryResult } from '../entities/recovery-result.entity';
import { PriceAlertEntity } from '../entities/price-alert.entity';
import { SmaRecord } from '../entities/sma-record.entity';
import { SmaService } from '../sma/sma.service';

const TIMEZONE = 'Asia/Bangkok';
const SYMBOLS = ['MSFT', 'NVDA', 'LLY', 'JNJ', 'JPM', 'V', 'AMZN', 'DIS', 'XOM', 'CVX'];

const SMA_PERIOD = 50;
const MIN_PRICE_DAYS = 50;
const VOLUME_AVG_DAYS = 20;
const MAX_FALLBACK_DAYS = 10;
const DROP_FROM_HIGH_THRESHOLD = 0.2;
const RECOVERY_FROM_LOW_THRESHOLD = 0.1;

// แคชผลลัพธ์ชั่วคราว (มิลลิวินาที) 0 = ปิดแคช
// ข้อมูลเป็นราคาปิดรายวัน การแคชสั้นๆ จึงไม่กระทบความถูกต้อง
// endpoint sync-now จะข้ามแคชเสมอ (บังคับวิเคราะห์ใหม่)
const CACHE_TTL_MS = 30_000;

const FAIL_PREFIX = 'ไม่ผ่านเกณฑ์: ';
const REASON_PASSED = 'ผ่านเกณฑ์หุ้นฟื้นทั้งหมด';
const REASON_NO_PRICE_IN_DB = `${FAIL_PREFIX}ไม่พบข้อมูลราคาหุ้นในฐานข้อมูลช่วงเวลานี้`;
const REASON_NO_PRICE_IN_PERIOD = `${FAIL_PREFIX}ไม่พบข้อมูลราคาหุ้นในช่วงเวลานี้`;
const REASON_NO_LATEST_PRICE = `${FAIL_PREFIX}ไม่มีข้อมูลราคาซื้อขายล่าสุดในระบบ`;

type SaveStatus = 'exists' | 'updated' | 'created';

interface RecoveryData {
  currentPrice: number;
  highestPrice: number;
  lowestPrice: number;
  avgVolume20: number;
  sma50: number;
  volume: number;
  isPassed: boolean;
  reason: string;
}

interface SaveResult {
  entity: RecoveryResult;
  status: SaveStatus;
}

interface AnalysisOutcome {
  analysisDate: string;
  data: RecoveryData;
}

interface PricePoint {
  date: string;
  close: number;
  volume: number;
}

interface PriceMetrics {
  latestPriceDate: string;
  currentPrice: number;
  currentVolume: number;
  highestPrice: number;
  lowestPrice: number;
  avgVolume20: number;
}

export interface RecoveryResponse {
  message: string;
  totalAnalyzed: number;
  totalPassed: number;
  statusCode: number;
  data: Array<Record<string, unknown>>;
}

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  /** request ที่กำลังประมวลผลอยู่ (แยกตาม periodMonths) เพื่อไม่ให้เปิด transaction ซ้อนกัน */
  private readonly inFlight = new Map<number, Promise<RecoveryResponse>>();

  /** แคชผลลัพธ์ล่าสุด (ใช้เมื่อ CACHE_TTL_MS > 0) */
  private readonly cache = new Map<number, { at: number; value: RecoveryResponse }>();

  constructor(
    private readonly dataSource: DataSource,

    @InjectRepository(RecoveryResult)
    private readonly recoveryResultRepository: Repository<RecoveryResult>,

    private readonly smaService: SmaService,
  ) { }

  // ---------------------------------------------------------------------------
  // Date helpers
  // ---------------------------------------------------------------------------

  private formatDateToYMD(dateInput: Date | string): string {
    const d = new Date(dateInput);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    return new Intl.DateTimeFormat('en-CA', options).format(d);
  }

  private formatDateTime(dateInput: Date | string): string {
    const d = new Date(dateInput);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    return new Intl.DateTimeFormat('sv-SE', options).format(d).replace(' ', 'T');
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  async processRecoveryStocks(
    periodMonths: number,
    options: { skipCache?: boolean } = {},
  ): Promise<RecoveryResponse> {
    if (periodMonths !== 3 && periodMonths !== 6) {
      throw new BadRequestException('กรุณากรอกช่วงเวลาให้ถูกต้อง (รองรับเฉพาะ 3 หรือ 6 เดือนเท่านั้น)');
    }

    if (!options.skipCache && CACHE_TTL_MS > 0) {
      const cached = this.cache.get(periodMonths);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
      }
    }

    // ถ้ามีงานของ period นี้กำลังรันอยู่ ให้รอผลลัพธ์เดียวกัน ไม่เปิด transaction ใหม่ซ้ำ
    const running = this.inFlight.get(periodMonths);
    if (running) {
      return running;
    }

    const task = this.runRecovery(periodMonths)
      .then((value) => {
        if (CACHE_TTL_MS > 0) {
          this.cache.set(periodMonths, { at: Date.now(), value });
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(periodMonths);
      });

    this.inFlight.set(periodMonths, task);
    return task;
  }

  // logic เดิมของ processRecoveryStocks (ย้ายมาไว้ที่นี่ ไม่มีการเปลี่ยนแปลง)
  private async runRecovery(periodMonths: number): Promise<RecoveryResponse> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const initialTargetDateStr = this.formatDateToYMD(yesterday);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      let hasUpdated = false;
      let hasExists = false;

      const targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() - periodMonths);
      const targetDateStr = this.formatDateToYMD(targetDate);

      for (const symbol of SYMBOLS) {
        // ต้องทำทีละตัวตามลำดับ: ทุก query ใช้ queryRunner/transaction เดียวกัน จึงห้ามรันขนาน
        const result = await this.analyzeAndSave( // NOSONAR
          queryRunner.manager,
          periodMonths,
          symbol,
          targetDateStr,
          initialTargetDateStr,
        );

        if (result.status === 'updated') hasUpdated = true;
        if (result.status === 'exists') hasExists = true;
      }

      await queryRunner.commitTransaction();

      return await this.buildResponse(periodMonths, hasUpdated, hasExists);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('ERROR DETAIL', error);
      throw new InternalServerErrorException(
        'เกิดข้อผิดพลาดในระบบ ไม่สามารถดำเนินงานได้',
      );
    } finally {
      await queryRunner.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------------------

  private resolveMessage(hasUpdated: boolean, hasExists: boolean): string {
    if (hasUpdated) return 'อัปเดตข้อมูลในตารางแล้ว';
    if (hasExists) return 'มีข้อมูลในตารางแล้ว';
    return 'วิเคราะห์หุ้นฟื้นตัวสำเร็จเรียบร้อยแล้ว';
  }

  private async buildResponse(
    periodMonths: number,
    hasUpdated: boolean,
    hasExists: boolean,
  ): Promise<RecoveryResponse> {
    const sortedResults = await this.recoveryResultRepository.find({
      where: { periodMonths: Number(periodMonths) },
      order: {
        analysisDate: 'DESC',
        symbol: 'ASC',
      },
    });

    return {
      message: this.resolveMessage(hasUpdated, hasExists),
      totalAnalyzed: sortedResults.length,
      totalPassed: sortedResults.filter(item => item.isPassed).length,
      statusCode: 200,
      data: sortedResults.map((entity) => {
        const rest: Partial<RecoveryResult> = { ...entity };
        delete rest.id;

        return {
          ...rest,
          analysisDate: rest.analysisDate ? String(rest.analysisDate).split('T')[0] : '',
          createdAt: this.formatDateTime(entity.createdAt),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private isSameResult(
    existing: RecoveryResult,
    data: RecoveryData,
    targetAnalysisDate: string,
  ): boolean {
    const dbAnalysisDateStr = existing.analysisDate ? String(existing.analysisDate).split('T')[0] : '';
    const targetDateStrOnly = String(targetAnalysisDate).split('T')[0];

    return (
      existing.isPassed === data.isPassed &&
      Number(existing.sma50) === Number(data.sma50) &&
      existing.reason === data.reason &&
      Number(existing.currentPrice) === Number(data.currentPrice) &&
      dbAnalysisDateStr === targetDateStrOnly
    );
  }

  private async saveOrUpdateResult(
    manager: EntityManager,
    periodMonths: number,
    symbol: string,
    targetAnalysisDate: string,
    data: RecoveryData,
  ): Promise<SaveResult> {
    const existing = await manager.findOne(RecoveryResult, {
      where: {
        symbol,
        periodMonths: Number(periodMonths),
      },
    });

    const currentTime = new Date();

    if (!existing) {
      const created = manager.create(RecoveryResult, {
        symbol,
        analysisDate: targetAnalysisDate,
        periodMonths: Number(periodMonths),
        createdAt: currentTime,
        ...data,
      });
      const savedNew = await manager.save(created);
      return { entity: savedNew, status: 'created' };
    }

    if (this.isSameResult(existing, data, targetAnalysisDate)) {
      existing.createdAt = currentTime;
      return { entity: existing, status: 'exists' };
    }

    existing.analysisDate = targetAnalysisDate;
    existing.currentPrice = data.currentPrice;
    existing.highestPrice = data.highestPrice;
    existing.lowestPrice = data.lowestPrice;
    existing.avgVolume20 = data.avgVolume20;
    existing.sma50 = data.sma50;
    existing.volume = data.volume;
    existing.isPassed = data.isPassed;
    existing.reason = data.reason;
    existing.createdAt = currentTime;

    const savedUpdated = await manager.save(existing);
    return { entity: savedUpdated, status: 'updated' };
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  private buildFailedData(reason: string, overrides: Partial<RecoveryData> = {}): RecoveryData {
    return {
      currentPrice: 0,
      highestPrice: 0,
      lowestPrice: 0,
      avgVolume20: 0,
      sma50: 0,
      volume: 0,
      isPassed: false,
      reason,
      ...overrides,
    };
  }

  private hasEodPrice(record: PriceAlertEntity | undefined): record is PriceAlertEntity {
    return !!record && record.eod_price !== null && record.eod_price !== undefined;
  }

  private buildPriceMap(rawPrices: PriceAlertEntity[]): Map<string, PriceAlertEntity> {
    const priceMap = new Map<string, PriceAlertEntity>();
    for (const p of rawPrices) {
      if (p.price_date) {
        priceMap.set(this.formatDateToYMD(p.price_date), p);
      }
    }
    return priceMap;
  }

  /** ถอยหลังหาวันที่มีราคาปิด (กรณีวันหยุด) ไม่เกิน MAX_FALLBACK_DAYS วัน */
  private findLatestTradingRecord(
    priceMap: Map<string, PriceAlertEntity>,
    initialTargetDateStr: string,
    initialRecord: PriceAlertEntity,
  ): { record: PriceAlertEntity; dateStr: string } | null {
    let dateStr = initialTargetDateStr;
    let record: PriceAlertEntity | undefined = initialRecord;

    const checkDate = new Date(initialTargetDateStr);
    let remaining = MAX_FALLBACK_DAYS;

    while (remaining > 0 && !this.hasEodPrice(record)) {
      checkDate.setDate(checkDate.getDate() - 1);
      dateStr = this.formatDateToYMD(checkDate);
      record = priceMap.get(dateStr);
      remaining--;
    }

    return this.hasEodPrice(record) ? { record, dateStr } : null;
  }

  private extractValidPrices(rawPrices: PriceAlertEntity[], targetAnalysisDateStr: string): PricePoint[] {
    return rawPrices
      .filter(p => p.price_date && this.formatDateToYMD(p.price_date) <= targetAnalysisDateStr && p.eod_price !== null && p.eod_price !== undefined)
      .map(p => ({
        date: this.formatDateToYMD(p.price_date),
        close: Number(p.eod_price),
        volume: Number(p.volume || 0),
      }));
  }

  private calculateMetrics(validPrices: PricePoint[]): PriceMetrics {
    // เรียกหลังตรวจแล้วว่า validPrices.length >= MIN_PRICE_DAYS จึงไม่ว่างแน่นอน
    const latestData = validPrices.at(-1) as PricePoint;

    const closes = validPrices.map(p => p.close);
    const last20Volumes = validPrices.slice(-VOLUME_AVG_DAYS).map(p => p.volume);

    return {
      latestPriceDate: latestData.date,
      currentPrice: latestData.close,
      currentVolume: latestData.volume,
      highestPrice: Math.max(...closes),
      lowestPrice: Math.min(...closes),
      avgVolume20: last20Volumes.reduce((a, b) => a + b, 0) / last20Volumes.length,
    };
  }

  private isSmaCurrent(smaRecord: SmaRecord | null | undefined, latestPriceDate: string): boolean {
    return !!smaRecord?.latestDate && this.formatDateToYMD(smaRecord.latestDate) === latestPriceDate;
  }

  private findLatestSmaRecord(manager: EntityManager, symbol: string): Promise<SmaRecord | null> {
    return manager
      .createQueryBuilder(SmaRecord, 'sma')
      .where('sma.symbol = :symbol', { symbol })
      .andWhere('sma.period = :period', { period: SMA_PERIOD })
      .orderBy('sma.calculatedAt', 'DESC')
      .getOne();
  }

  /** ดึง SMA50 ล่าสุด ถ้าไม่ตรงกับวันที่ราคาล่าสุดจะสั่งคำนวณใหม่แล้วดึงอีกครั้ง */
  private async resolveSmaRecord(
    manager: EntityManager,
    symbol: string,
    latestPriceDate: string,
  ): Promise<SmaRecord | null> {
    let smaRecord = await this.findLatestSmaRecord(manager, symbol);

    if (this.isSmaCurrent(smaRecord, latestPriceDate)) {
      return smaRecord;
    }

    try {
      await this.smaService.processSmaRequest({ symbol, period: SMA_PERIOD });
      smaRecord = await this.findLatestSmaRecord(manager, symbol);
    } catch (error) {
      this.logger.error(`ไม่สามารถคำนวณ SMA สำหรับ ${symbol} ได้:`, error);
    }

    return smaRecord;
  }

  private evaluateCriteria(metrics: PriceMetrics, sma50: number) {
    const { currentPrice, highestPrice, lowestPrice, currentVolume, avgVolume20 } = metrics;

    const dropFromHigh = (highestPrice - currentPrice) / highestPrice >= DROP_FROM_HIGH_THRESHOLD;
    const recoveryFromLow = (currentPrice - lowestPrice) / lowestPrice >= RECOVERY_FROM_LOW_THRESHOLD;
    const volumeCondition = currentVolume > avgVolume20;
    const smaCondition = currentPrice > sma50;

    const isPassed = dropFromHigh && recoveryFromLow && volumeCondition && smaCondition;

    if (isPassed) {
      return { isPassed, reason: REASON_PASSED };
    }

    const failedCriteria: string[] = [];
    if (!dropFromHigh) failedCriteria.push('ราคาตกจากจุดสูงสุดยังไม่ถึง 20%');
    if (!recoveryFromLow) failedCriteria.push('การฟื้นตัวจากจุดต่ำสุดยังไม่ถึง 10%');
    if (!volumeCondition) failedCriteria.push('ปริมาณการซื้อขายรายวันน้อยกว่าค่าเฉลี่ยปริมาณการซื้อขายย้อนหลัง 20 วัน');
    if (!smaCondition) failedCriteria.push('ราคาปิดปัจจุบันต่ำกว่าเส้น SMA50');

    return { isPassed, reason: `${FAIL_PREFIX}${failedCriteria.join(', ')}` };
  }

  private async analyzeAndSave(
    manager: EntityManager,
    periodMonths: number,
    symbol: string,
    targetDateStr: string,
    initialTargetDateStr: string,
  ): Promise<SaveResult> {
    const outcome = await this.analyzeSymbol(manager, symbol, targetDateStr, initialTargetDateStr);

    return this.saveOrUpdateResult(
      manager,
      periodMonths,
      symbol,
      outcome.analysisDate,
      outcome.data,
    );
  }

  private async analyzeSymbol(
    manager: EntityManager,
    symbol: string,
    targetDateStr: string,
    initialTargetDateStr: string,
  ): Promise<AnalysisOutcome> {
    const failAtInitial = (reason: string): AnalysisOutcome => ({
      analysisDate: initialTargetDateStr,
      data: this.buildFailedData(reason),
    });

    const rawPrices = await manager
      .createQueryBuilder(PriceAlertEntity, 's')
      .where('s.symbol = :symbol', { symbol })
      .andWhere('s.price_date >= :targetDateStr', { targetDateStr })
      .orderBy('s.price_date', 'ASC')
      .getMany();

    if (!rawPrices || rawPrices.length === 0) {
      return failAtInitial(REASON_NO_PRICE_IN_DB);
    }

    const priceMap = this.buildPriceMap(rawPrices);
    const initialRecord = priceMap.get(initialTargetDateStr);

    if (!initialRecord) {
      return failAtInitial(REASON_NO_PRICE_IN_PERIOD);
    }

    const latestTrading = this.findLatestTradingRecord(priceMap, initialTargetDateStr, initialRecord);

    if (!latestTrading) {
      return failAtInitial(REASON_NO_LATEST_PRICE);
    }

    const targetAnalysisDateStr = latestTrading.dateStr;
    const validPrices = this.extractValidPrices(rawPrices, targetAnalysisDateStr);

    if (validPrices.length < MIN_PRICE_DAYS) {
      return {
        analysisDate: targetAnalysisDateStr,
        data: this.buildFailedData(
          `${FAIL_PREFIX}ข้อมูลราคาในฐานข้อมูลไม่เพียงพอสำหรับการวิเคราะห์ (มีเพียง ${validPrices.length} วัน ต้องการอย่างน้อย ${MIN_PRICE_DAYS} วัน)`,
        ),
      };
    }

    const metrics = this.calculateMetrics(validPrices);
    const smaRecord = await this.resolveSmaRecord(manager, symbol, metrics.latestPriceDate);
    const sma50 = smaRecord ? Number(smaRecord.smaValue) : 0;

    if (sma50 === 0 || !this.isSmaCurrent(smaRecord, metrics.latestPriceDate)) {
      return {
        analysisDate: targetAnalysisDateStr,
        data: this.buildFailedData(
          `${FAIL_PREFIX}ไม่พบข้อมูลเส้นค่าเฉลี่ย SMA50 ที่มี latestDate ตรงกับวันที่ ${metrics.latestPriceDate} ในระบบ`,
          {
            currentPrice: metrics.currentPrice,
            highestPrice: metrics.highestPrice,
            lowestPrice: metrics.lowestPrice,
            avgVolume20: metrics.avgVolume20,
            volume: metrics.currentVolume,
          },
        ),
      };
    }

    const { isPassed, reason: baseReason } = this.evaluateCriteria(metrics, sma50);

    const reason =
      targetAnalysisDateStr === initialTargetDateStr
        ? baseReason
        : `วันที่ ${initialTargetDateStr} เป็นวันหยุด ระบบจึงใช้ข้อมูลการวิเคราะห์ของวันที่ ${targetAnalysisDateStr} แทน ${baseReason}`;

    return {
      analysisDate: targetAnalysisDateStr,
      data: {
        currentPrice: metrics.currentPrice,
        highestPrice: metrics.highestPrice,
        lowestPrice: metrics.lowestPrice,
        avgVolume20: metrics.avgVolume20,
        sma50,
        volume: metrics.currentVolume,
        isPassed,
        reason,
      },
    };
  }
}