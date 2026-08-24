// Minimal chainable fake for the subset of the supabase-js query builder API
// used by the edge functions: from/select/eq/is/lt/or/order/insert/update
// plus the terminal maybeSingle()/single(), and being awaitable directly
// (mirrors supabase-js's PromiseLike query builders, used when a query is
// awaited without a terminal .single()/.maybeSingle() call).

export interface Call {
  method: string;
  args: unknown[];
}

export interface Result {
  data: unknown;
  error: unknown;
}

// Called once per from(table) query, with that query's recorded chain calls
// and its 0-based index among all from() calls made on the client so far.
// Lets a test either return fixed fixtures per call, or inspect the chain
// (e.g. the args passed to .or()) to compute a response.
export type Resolver = (table: string, calls: Call[], callIndex: number) => Result;

export class FakeQuery implements PromiseLike<Result> {
  calls: Call[];

  constructor(private resolve_: () => Result, calls: Call[] = []) {
    this.calls = calls;
  }

  private rec(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }

  select(...a: unknown[]): this { return this.rec("select", a); }
  eq(...a: unknown[]): this { return this.rec("eq", a); }
  is(...a: unknown[]): this { return this.rec("is", a); }
  lt(...a: unknown[]): this { return this.rec("lt", a); }
  or(...a: unknown[]): this { return this.rec("or", a); }
  order(...a: unknown[]): this { return this.rec("order", a); }
  insert(...a: unknown[]): this { return this.rec("insert", a); }
  update(...a: unknown[]): this { return this.rec("update", a); }

  maybeSingle(): Promise<Result> { return Promise.resolve(this.resolve_()); }
  single(): Promise<Result> { return Promise.resolve(this.resolve_()); }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve_()).then(onfulfilled, onrejected);
  }
}

export class FakeClient {
  fromCalls: { table: string; calls: Call[] }[] = [];

  constructor(private resolver: Resolver) {}

  from(table: string): FakeQuery {
    const idx = this.fromCalls.length;
    const calls: Call[] = [];
    const q = new FakeQuery((): Result => this.resolver(table, calls, idx), calls);
    this.fromCalls.push({ table, calls });
    return q;
  }
}
