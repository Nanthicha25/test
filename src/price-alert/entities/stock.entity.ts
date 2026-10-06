import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

@Entity('price_alert_stocks')
@Unique(['symbol', 'price_date']) // 🟢 เพิ่ม Unique Constraint สำหรับ Upsert
export class Stock {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  symbol: string;

  @Column({ nullable: true })
  name: string;

  @Column({ nullable: true })
  industry: string;

  @Column('numeric', { precision: 12, scale: 4, nullable: true })
  eod_price: number;

  @Column('numeric', { precision: 12, scale: 4, nullable: true })
  open: number | null;

  @Column('numeric', { precision: 12, scale: 4, nullable: true })
  high: number | null;

  @Column('numeric', { precision: 12, scale: 4, nullable: true })
  low: number | null;

  @Column('bigint', { nullable: true })
  volume: number | null;

  @Column('numeric', { precision: 20, scale: 2, nullable: true })
  market_cap: number | null;

  @Column({ type: 'date' })
  price_date: string;
}