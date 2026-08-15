import winston from "winston";
import { LoggingWinston } from "@google-cloud/logging-winston";

const loggingWinston = new LoggingWinston({
  logName: "wearthistea",
  redirectToStdout: process.env.NODE_ENV !== "production",
});

export const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    loggingWinston,
  ],
});
