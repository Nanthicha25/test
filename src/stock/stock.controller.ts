import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { StockService } from './stock.service';

interface ProcessRecoveryDto {
  months?: number | string;
  period?: number | string;
  periodMonths?: number | string;
}

@Controller('stocks')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Post('sync-now')
  @HttpCode(200)
  async syncNow(@Body() body: ProcessRecoveryDto) {
    const requestedMonths = body.months || body.period || body.periodMonths;

    return this.stockService.processRecoveryStocks(Number(requestedMonths), { skipCache: true });
  }

  @Post('recovery')
  @HttpCode(200)
  async processRecovery(@Body() body: ProcessRecoveryDto) {
    const requestedMonths = body.period || body.periodMonths || body.months;
    return this.stockService.processRecoveryStocks(Number(requestedMonths));
  }
}