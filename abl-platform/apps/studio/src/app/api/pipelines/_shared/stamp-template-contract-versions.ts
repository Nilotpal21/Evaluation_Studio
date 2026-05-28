import { ContractRegistry } from '@agent-platform/pipeline-engine/contracts';

export const contractRegistry = new ContractRegistry();

export function stampTemplateContractVersions(nodes: Array<Record<string, unknown>>) {
  return nodes.map((node) => {
    const contract = contractRegistry.getNode(node.type as string);
    return contract ? { ...node, contractVersion: contract.contractVersion } : node;
  });
}
