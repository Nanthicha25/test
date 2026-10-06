import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; 
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecoveryResult } from './entities/recovery-result.entity'; 
import { StockModule } from './stock/stock.module';
import { PriceAlertEntity } from './entities/price-alert.entity'; 
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SmaRecord } from './entities/sma-record.entity';
import { SmaModule } from './sma/sma.module';
import { PriceHistory } from './sma/entities/price-history.entity';
@Module({
  imports: [
    
    ConfigModule.forRoot({
      isGlobal: true,
    }),

   
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [ RecoveryResult, PriceAlertEntity, SmaRecord, PriceHistory], 
      synchronize: true, 
    }),
    StockModule,
    SmaModule,
    TypeOrmModule.forFeature([PriceAlertEntity]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}