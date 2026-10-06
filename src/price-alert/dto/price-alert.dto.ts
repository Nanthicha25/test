import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class CreatePriceAlertDto {
  @IsString()
  @IsNotEmpty()
  user_id: string;

  @IsString()
  @IsNotEmpty()
  symbol: string;

  @IsNumber()
  @IsNotEmpty()
  @Min(0)
  target_price: number;
}