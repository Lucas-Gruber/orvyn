import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { createDiagnostics } from "@orvyn/shared/server";

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof HttpException)
      return response.status(error.getStatus()).json(error.getResponse());
    createDiagnostics("api", process.env).error("request.failed", {
      stage: "http",
      error,
    });
    return response
      .status(500)
      .json({
        message: "The request could not be completed. Please try again.",
      });
  }
}
