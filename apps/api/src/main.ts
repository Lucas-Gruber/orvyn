import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Controller, Get, Post, Put, Req, Res, Body, Param, HttpException } from '@nestjs/common';
import { Pool } from 'pg';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,(err,key)=>err?reject(err):resolve(key)));
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const fail = (status: number, message: string): never => { throw new HttpException({ message }, status); };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function text(value: unknown, max: number) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Invalid input'); return (value as string).trim(); }
function mutation(req: any) { if (req.headers.origin !== (process.env.ORVYN_ORIGIN || 'http://localhost:3000')) fail(403, 'Invalid origin'); if (!req.is('application/json')) fail(415, 'JSON required'); }
async function user(req: any) {
  const token = /(?:^|;\s*)orvyn_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return fail(401, 'Sign in required');
  const result = await db.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()', [hash(token)]);
  if (!result.rowCount) return fail(401, 'Session expired');
  return result.rows[0].user_id as string;
}
// One transaction and advisory lock make first-run schema installation atomic.
async function migrate() {
  const c = await db.connect();
  try {
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(782901)');
    await c.query(`CREATE TABLE IF NOT EXISTS auth_limits(key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password_hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL);
      CREATE INDEX IF NOT EXISTS spaces_owner ON spaces(owner_id);
      CREATE TABLE IF NOT EXISTS pages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, title text NOT NULL, document jsonb NOT NULL DEFAULT '{"type":"doc","content":[]}', version integer NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS pages_space ON pages(space_id);
      INSERT INTO schema_migrations VALUES(1) ON CONFLICT DO NOTHING;`);
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
@Controller('api/v1')
class Api {
  @Get('health') async health() { await db.query('SELECT 1'); return { status: 'ok' }; }
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
  @Get('spaces') async spaces(@Req() req:any) { return (await db.query('SELECT id,name FROM spaces WHERE owner_id=$1 ORDER BY name',[await user(req)])).rows; }
  @Post('spaces') async addSpace(@Req() req:any,@Body() body:any) { mutation(req); return (await db.query('INSERT INTO spaces(owner_id,name) VALUES($1,$2) RETURNING id,name',[await user(req),text(body?.name,120)])).rows[0]; }
  @Get('spaces/:id/pages') async pages(@Req() req:any,@Param('id') id:string) {
    return (await db.query('SELECT p.* FROM pages p JOIN spaces s ON s.id=p.space_id WHERE s.id::text=$1 AND s.owner_id=$2 ORDER BY p.title',[id,await user(req)])).rows;
  }
  @Post('spaces/:id/pages') async addPage(@Req() req:any,@Param('id') id:string,@Body() body:any) {
    mutation(req); const r=await db.query('INSERT INTO pages(space_id,title) SELECT id,$1 FROM spaces WHERE id::text=$2 AND owner_id=$3 RETURNING *',[text(body?.title,300),id,await user(req)]);
    return r.rows[0] || fail(404,'Not found');
  }
  @Put('pages/:id') async save(@Req() req:any,@Param('id') id:string,@Body() body:any) {
    mutation(req); const uid=await user(req);
    if(!Number.isSafeInteger(body?.version) || body?.document?.type!=='doc' || !Array.isArray(body.document.content) || body.document.content.some((n:any)=> n?.type!=='paragraph' || typeof n.text!=='string') || JSON.stringify(body.document).length>100000) fail(400,'Invalid document');
    const r=await db.query('UPDATE pages p SET title=$1,document=$2,version=version+1 FROM spaces s WHERE s.id=p.space_id AND s.owner_id=$3 AND p.id::text=$4 AND p.version=$5 RETURNING p.*',[text(body.title,300),body.document,uid,id,body.version]);
    if(!r.rowCount) fail(409,'Page unavailable or changed; reload before saving'); return r.rows[0];
  }
}
@Module({ controllers: [Api] }) class App {}
async function main() { if(!process.env.DATABASE_URL) throw Error('DATABASE_URL required'); await migrate(); const app=await NestFactory.create(App); app.use((req:any,res:any,next:any)=>{ res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); next(); }); await app.listen(3001,'0.0.0.0'); }
main().catch(()=>{ console.error('API startup failed; verify database configuration'); process.exit(1); });
