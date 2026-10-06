import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { SmaService } from './sma.service';
import { CalculateSmaDto } from './dto/calculate-sma.dto';
import { SmaResponseDto } from './dto/sma-response.dto';

@Controller('api/v1/indicators')
export class SmaController {
  constructor(private readonly smaService: SmaService) {}

  @Post('sma')
  @HttpCode(HttpStatus.OK)
  async calculateSMA(@Body() calculateSmaDto: CalculateSmaDto): Promise<SmaResponseDto> {
    return await this.smaService.processSmaRequest(calculateSmaDto);
  }
}