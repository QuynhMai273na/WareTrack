import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { VisitsService } from './visits.service';

/** Job định kỳ của Yard: NO_SHOW (DEC-24), hết hạn giữ dock (DEC-28). Chạy in-process (DEC-05). */
@Injectable()
export class YardScheduler {
  private readonly logger = new Logger(YardScheduler.name);
  private running = false;

  constructor(private readonly visits: VisitsService) {}

  @Interval(60_000)
  async tick() {
    if (this.running || process.env.SCHEDULER_DISABLED === 'true') return;
    this.running = true;
    try {
      const noShows = await this.visits.markNoShows();
      const expired = await this.visits.expireDockReservations();
      if (noShows || expired) this.logger.log(`no-show: ${noShows}, expired dock reservations: ${expired}`);
    } catch (err) {
      this.logger.error(`Yard scheduler failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
