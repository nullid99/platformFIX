-- New devices must be explicitly approved by an owner or assigned curator.
ALTER TYPE "SessionStatus" ADD VALUE 'PENDING';
