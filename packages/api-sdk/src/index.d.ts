export type ProtocolVersion = `${number}.${number}`;

export type SettldClientOptions = {
  baseUrl: string;
  tenantId: string;
  protocol?: ProtocolVersion;
  apiKey?: string;
  fetch?: typeof fetch;
  userAgent?: string;
};

export type RequestOptions = {
  requestId?: string;
  idempotencyKey?: string;
  expectedPrevChainHash?: string;
  signal?: AbortSignal;
};

export type SettldError = {
  status: number;
  code?: string | null;
  message: string;
  details?: unknown;
  requestId?: string | null;
};

export type SettldResponse<T> = {
  ok: boolean;
  status: number;
  requestId: string | null;
  body: T;
  headers: Record<string, string>;
};

export class SettldClient {
  constructor(opts: SettldClientOptions);

  capabilities(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  openApi(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  createJob(body: { templateId: string } & Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  getJob(jobId: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  quoteJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  bookJob(jobId: string, body: Record<string, unknown>, opts: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  appendJobEvent(jobId: string, body: Record<string, unknown>, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  opsStatus(opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  listPartyStatements(
    params: { period: string; partyId?: string; status?: string },
    opts?: RequestOptions
  ): Promise<SettldResponse<Record<string, unknown>>>;
  getPartyStatement(partyId: string, period: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
  enqueuePayout(partyId: string, period: string, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;

  requestMonthClose(body: { month: string; basis?: string }, opts?: RequestOptions): Promise<SettldResponse<Record<string, unknown>>>;
}

