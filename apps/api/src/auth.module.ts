import { Module, Controller, Get, Post, Put, Req, Res, Body, Param } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db, derive, hash, fail, text, mutation, user } from './runtime';
@Controller('api/v1')
class AuthController {
  @Post('auth/:action') async auth(@Param('action') action: string, @Req() req: any, @Res({ passthrough: true }) res: any, @Body() body: any) {
    mutation(req);
    if (action === 'logout') { const token = /orvyn_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; if(token) await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(token)]); res.setHeader('Set-Cookie','orvyn_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return { ok:true }; }
    if (!['register','login'].includes(action)) fail(404,'Not found');
    const limit=await db.query(`INSERT INTO auth_limits VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_limits.reset_at<now() THEN 1 ELSE auth_limits.attempts+1 END, reset_at=CASE WHEN auth_limits.reset_at<now() THEN now()+interval '15 minutes' ELSE auth_limits.reset_at END RETURNING attempts`,[hash(req.ip)]);
    if(limit.rows[0].attempts>30) fail(429,'Too many attempts; retry later');
    const email = text(body?.email,254).toLowerCase(); const password = text(body?.password,256);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) fail(400,'Use a valid email and at least 12 password characters');
    if(action==='register') {
      const salt=randomBytes(16).toString('hex'); const digest=(await derive(password,salt)).toString('hex');
      await db.query('INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[email,`${salt}:${digest}`]);
    }
    const result=await db.query('SELECT id,password_hash FROM users WHERE email=$1',[email]);
    const [salt,digest]=(result.rows[0]?.password_hash || '00000000000000000000000000000000:'+'0'.repeat(128)).split(':');
    if (!timingSafeEqual(await derive(password,salt),Buffer.from(digest,'hex')) || !result.rowCount) fail(401,'Invalid credentials');
    const token=randomBytes(32).toString('hex');
    await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",[hash(token),result.rows[0].id]);
    res.setHeader('Set-Cookie',`orvyn_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`);
    return { email };
  }
}
@Module({ controllers: [AuthController] })
export class AuthModule {}
