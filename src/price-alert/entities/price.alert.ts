import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('user_price_alerts') //ฟีเจอร์ผู้ใช้
export class PriceAlert {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: string;

  @Column()
  symbol: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  target_price: number;

  @Column({ default: false })
  is_triggered: boolean;

  @CreateDateColumn()
  created_at: Date;
}