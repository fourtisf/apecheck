/** Prisma enums are UPPERCASE; the API and the UI use lowercase. Convert at the boundary. */
import type { Signal, ClaimStatus, DeployerRecord } from './scoring';
import type { CheckStatusS, StepStatusS, ViaS, TierS } from './dto';
import type { TargetKindS } from './detect';

const lower = <T extends string>(v: string | null | undefined) => (v ? (v.toLowerCase() as T) : null);
const upper = <T extends string>(v: string | null | undefined) => (v ? (v.toUpperCase() as T) : null);

export const sigFromDb = (v: string | null | undefined) => lower<Signal>(v);
export const sigToDb = (v: Signal | null | undefined) => upper<'OK' | 'WARN' | 'FAIL'>(v);

export const claimStatusFromDb = (v: string) => v.toLowerCase() as ClaimStatus;
export const claimStatusToDb = (v: ClaimStatus) => v.toUpperCase() as 'SEEN_WORKING' | 'NOT_SEEN' | 'CONTRADICTED' | 'CHECKS_OUT';

export const recordFromDb = (v: string) => v.toLowerCase() as DeployerRecord;
export const recordToDb = (v: DeployerRecord) => v.toUpperCase() as 'BUILDER' | 'MIXED' | 'SERIAL';

export const statusFromDb = (v: string) => v.toLowerCase() as CheckStatusS;
export const stepStatusFromDb = (v: string) => v.toLowerCase() as StepStatusS;
export const stepStatusToDb = (v: StepStatusS) => v.toUpperCase() as 'INFO' | 'OK' | 'WARN' | 'FAIL';

export const viaFromDb = (v: string) => v.toLowerCase() as ViaS;
export const tierFromDb = (v: string) => v.toLowerCase() as TierS;

export const kindFromDb = (v: string) => v.toLowerCase() as TargetKindS;
export const kindToDb = (v: TargetKindS) => v.toUpperCase() as 'COIN' | 'POST' | 'SITE';
