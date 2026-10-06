//Input Validation DTO ตรวจกรองข้อมูล" ที่ส่งเข้ามาคำนวณ SMA

import { IsString, IsNotEmpty, IsInt, IsIn, MinLength, MaxLength } from 'class-validator';

export class CalculateSmaDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1) 
  @MaxLength(20) 
  symbol: string;

  @IsInt()
  @IsIn([5, 10, 20, 30, 50, 90, 180, 200], { 
    message: 'period ต้องเป็นหนึ่งในค่าที่ระบบรองรับ: 5, 10, 20, 30, 50, 90, 180, 200' 
  })
  period: number;
}