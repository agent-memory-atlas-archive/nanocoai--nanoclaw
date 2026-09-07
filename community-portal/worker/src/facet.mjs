// celld 0.4.1 facets require the Worker Loader. This static, trusted module has
// no fetch binding or user-supplied code. The root owns sockets and alarms;
// this facet owns the rebuildable perks read model in a separate database.
export const PERKS_FACET_SOURCE = `
import { DurableObject } from 'cloudflare:workers';
export default { fetch() { return new Response('Not found', { status: 404 }); } };
export class PerksMirror extends DurableObject {
  constructor(ctx, env) { super(ctx, env); }
  async read() { return await this.ctx.storage.get('snapshot') ?? null; }
  async update(snapshot) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.read();
      if (previous && snapshot.revision <= previous.revision) return false;
      await this.ctx.storage.put('snapshot', snapshot);
      return true;
    });
  }
}
`;
