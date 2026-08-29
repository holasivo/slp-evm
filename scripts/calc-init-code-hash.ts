import hre from 'hardhat';
import { Address, keccak256 } from 'viem';

async function main() {
  const contractName = 'ERC1967Proxy';
  const artifact = await hre.artifacts.readArtifact(contractName);
  const { bytecode } = artifact;
  const initCodeHash = keccak256(bytecode as Address);
  console.log(`Initialization code hash: ${initCodeHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
