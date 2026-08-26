/*
  Warnings:

  - Added the required column `nonceHash` to the `TelegramAuthChallenge` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TelegramAuthChallenge" ADD COLUMN     "nonceHash" TEXT NOT NULL;
