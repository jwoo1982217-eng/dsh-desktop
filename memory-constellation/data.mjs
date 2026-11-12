export class Constellation {
 constructor(ctx){this.ctx=ctx;}
 get memory(){const memory=this.ctx.get('dshKnowledgeWorkbench')?.memory;if(!memory)throw Object.assign(Error('统一知识库尚未就绪'),{status:503});return memory;}
 access(...a){return this.memory.access(...a)}
 snapshot(...a){return this.memory.snapshot(...a)}
 page(...a){return this.memory.page(...a)}
 search(...a){return this.memory.search(...a)}
 recall(...a){return this.memory.recall(...a)}
 read(...a){return this.memory.read(...a)}
 mutate(...a){return this.memory.mutate(...a)}
}
