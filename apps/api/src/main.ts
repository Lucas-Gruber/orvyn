import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { migrate } from './runtime';
import { AuthModule } from './auth.module';
import { SpacesModule } from './spaces.module';
import { PagesModule } from './pages.module';
import { HealthModule } from './health.module';
@Module({ imports: [AuthModule, SpacesModule, PagesModule, HealthModule] }) class App {}
async function main() { if(!process.env.DATABASE_URL) throw Error('DATABASE_URL required'); await migrate(); const app=await NestFactory.create(App); app.use((req:any,res:any,next:any)=>{ res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); next(); }); await app.listen(3001,'0.0.0.0'); }
main().catch(()=>{ console.error('API startup failed; verify database configuration'); process.exit(1); });
