import { expect,it } from 'vitest';
import { schemaProductionInventory } from '../../../scripts/schema-production-inventory.mjs';
it('uses narrow standalone validators in every production worker/shell consumer, not authoring factories',async()=>{
  const inventory=await schemaProductionInventory();
  const consumers=inventory.imports.filter(item=>!item.file.startsWith('packages/schema/'));
  expect(consumers.filter(item=>!item.module.startsWith('@clay/schema/standalone/'))).toEqual([]);
  expect(inventory.factories.filter(item=>!item.file.startsWith('packages/schema/'))).toEqual([]);
});
