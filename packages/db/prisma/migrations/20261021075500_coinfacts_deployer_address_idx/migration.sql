-- Deployer history from ApeCheck's own checks: the other coins with the same CoinFacts.deployerAddress.
-- Additive only: the retired "Deployer" table, "CoinFacts"."deployerId" and the "DeployerRecord" enum stay this release.

-- CreateIndex
CREATE INDEX "CoinFacts_deployerAddress_idx" ON "CoinFacts"("deployerAddress");
