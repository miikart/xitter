// The 2013 apps fetch pictures with a plain GET that carries no sign-in, while uploads
// here are for signed-in accounts only. Their API answers therefore link each picture
// with a token that stands for the account for 60 days and reads media, nothing else.

import { createHmac, timingSafeEqual } from "node:crypto";
import { tokenKey } from "./chat";

const DAY = 86_400_000;
const sign = (userId: string, day: number) => createHmac("sha256", tokenKey).update(`media:${userId}:${day}`).digest("hex").slice(0, 32);

export const mediaToken = (userId: string) => {
	const day = Math.floor(Date.now() / DAY) + 60;
	return `${userId}.${day}.${sign(userId, day)}`;
};

export function mediaTokenUser(token: string): string | undefined {
	const [userId, day, sig] = token.split(".");
	if (!/^\d{1,19}$/.test(userId ?? "") || !/^\d+$/.test(day ?? "") || Number(day) < Date.now() / DAY || !sig) return undefined;
	const want = Buffer.from(sign(userId, Number(day)));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got) ? userId : undefined;
}
