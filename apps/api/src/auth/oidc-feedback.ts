import { HttpException } from "@nestjs/common";
import { type OidcFeedbackCode } from "@orvyn/shared";

export class OidcLoginError extends HttpException {
  constructor(
    status: number,
    public readonly feedback: OidcFeedbackCode,
    message: string,
  ) {
    super({ message }, status);
  }
}
export function loginFail(
  status: number,
  code: OidcFeedbackCode,
  message: string,
): never {
  throw new OidcLoginError(status, code, message);
}
export function browserNavigation(req: any) {
  return (
    req.headers["sec-fetch-mode"] === "navigate" ||
    /(?:^|[,;\s])text\/html(?:[,;\s]|$)/i.test(req.headers.accept || "")
  );
}
