//พิมพ์เขียวสำหรับ บันทึกประวัติผลลัพธ์การคำนวณ SMA ลงในฐานข้อมูลกลาง
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('sma_records')
export class SmaRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'int' })
  period: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  smaValue: number;

  @Column({ type: 'int' })
  dataPointsUsed: number;

  @Column({ type: 'date', nullable: true })
  latestDate: string;
  
  @CreateDateColumn({ type: 'timestamp' })
  calculatedAt: Date;
}