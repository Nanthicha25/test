import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SmaService } from './sma.service';
import { SmaController } from './sma.controller';
import { SmaRecord } from '../entities/sma-record.entity';
import { PriceAlertEntity } from '../entities/price-alert.entity'; 

@Module({
  imports: [
    TypeOrmModule.forFeature([SmaRecord, PriceAlertEntity]), // ลงทะเบียน PriceAlert แทน Stock
  ],
  controllers: [SmaController],
  providers: [SmaService],
  exports: [SmaService],
})
export class SmaModule {}