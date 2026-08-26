import "reflect-metadata";
import "dotenv/config";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule } from "./app.module";

function getTrustProxySetting(): boolean | number {
  const configuredHops = process.env.TRUST_PROXY_HOPS?.trim();
  if (configuredHops) {
    const hops = Number(configuredHops);
    if (Number.isInteger(hops) && hops >= 0) return hops;
  }
  return process.env.TRUST_PROXY === "true" ? 1 : false;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.getHttpAdapter().getInstance().set("trust proxy", getTrustProxySetting());
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix("api");

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`FIX API listening on port ${port}`);
}

void bootstrap();
