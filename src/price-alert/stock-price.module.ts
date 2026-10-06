import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios'; 
import { TypeOrmModule } from '@nestjs/typeorm';
import { Stock } from './entities/stock.entity';
import { StockPriceService } from './stock-price.service';
import { StockPriceController } from './stock-price.controller';
import { PriceAlert } from './entities/price.alert';

@Module({
  imports: [
    HttpModule, 
    TypeOrmModule.forFeature([Stock , PriceAlert]),
  ],
  controllers: [StockPriceController],
  providers: [StockPriceService],
  exports: [
    TypeOrmModule,
    StockPriceService, 
  ],
})
export class PriceAlertModule {} 