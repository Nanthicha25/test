import { Controller, Post, Body, Get } from '@nestjs/common';
import { StockPriceService } from './stock-price.service';
import { CreatePriceAlertDto } from './dto/price-alert.dto';

@Controller()
export class StockPriceController {
  constructor(private readonly priceAlertService: StockPriceService) {}

  // Route สำหรับสร้าง Price Alert
  @Post('alerts')
  async createAlert(@Body() dto: CreatePriceAlertDto) {
    return await this.priceAlertService.createPriceAlert(dto);
  }

  // Route ดึงรายการ Price Alert ทั้งหมด
  @Get('alerts')
  async getAlerts() {
    return await this.priceAlertService.getAllAlerts();
  }

  // Route สั่งอัปเดตราคา
  @Post('batch/update-prices')
  async updatePrices() {
    return await this.priceAlertService.updateAllStockPrices();
  }

  // Route ดึงหุ้นทั้งหมด
  @Get('stocks')
  async getStocks() {
    return await this.priceAlertService.getAllStocks();
  }
}