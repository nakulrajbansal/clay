import { ShareIdV1 } from "@clay/schema/standalone/share";

export function isRecipientSharePathV1(pathname: string): boolean {
  const match = pathname.match(/^\/share\/(shr_[a-z2-7]{26})$/);
  return !!match && ShareIdV1.safeParse(match[1]).success;
}
