import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

import { redactError } from '../indexer/indexer.service';

/** Never return driver/RPC exception text to an HTTP caller. */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      getHeader(name: string): string | number | string[] | undefined;
      status(code: number): { json(payload: unknown): void };
    }>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    const requestId = response.getHeader('X-Request-ID');
    if (statusCode >= 500) {
      this.logger.error(JSON.stringify({ requestId, error: redactError(exception) }));
    }
    response.status(statusCode).json({
      statusCode,
      requestId: typeof requestId === 'string' ? requestId : null,
      message:
        exception instanceof HttpException && statusCode < 500
          ? exception.message
          : 'Internal server error',
    });
  }
}
