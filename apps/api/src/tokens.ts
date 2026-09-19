/**
 * Injection tokens for values Nest cannot resolve by type.
 *
 * `ApiConfig` and `EvidenceStorage` are interfaces, which do not survive to
 * runtime, so they are provided under explicit tokens rather than by class.
 */
export const API_CONFIG = 'API_CONFIG';
export const EVIDENCE_STORAGE = 'EVIDENCE_STORAGE';
