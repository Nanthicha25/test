//DTO สำหรับกำหนดรูปแบบข้อมูลผลลัพธ์ที่จะส่งกลับ (Response) ให้ผู้เรียกใช้งาน
export class SmaResponseDto {
  symbol: string;
  period: number;
  sma_value: number;
  data_points_used: number;
  calculated_at: string;
}