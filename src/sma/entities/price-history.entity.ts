//TypeORM Entity สำหรับดึงข้อมูลราคาปิดหุ้น (Read-Only) จากตารางกลาง
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('stocks')
export class PriceHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true, name: 'eod_price' })
  closePrice: number;

  @Column({ type: 'date', nullable: true, name: 'price_date' })
  date: Date;
}