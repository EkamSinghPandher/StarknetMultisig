# Argent Accounts on Starknet

## Specification

See [Argent Account](./docs/argent_account.md) and [Argent Multisig](./docs/multisig.md) for more details.

## Deployments

See deployed class hashes can be found here for the [Argent Account](./deployments/account.txt), and here for the [Argent Multisig](./deployments/multisig.txt). These 
are useful when we are trying to precalculate the contract address. 

Other deployment artifacts are located in [/deployments/](./deployments/)

Find the release notes for all versions in [CHANGELOG](./CHANGELOG.md)

## Development

### Setup

We recommend you to install scarb through ASDF. Please refer to [these instructions](https://docs.swmansion.com/scarb/download.html#install-via-asdf).  
Thanks to the [.tool-versions file](./.tool-versions), you don't need to install a specific scarb or starknet foundry version. The correct one will be automatically downloaded and installed.

### Install the devnet (run in project root folder)

You should have docker installed in your machine then you can start the devnet by running the following command:

```shell
scarb run start-devnet
```


## Test the contracts (Cairo)
Remember to run the devnet prior to running this test.

```
scarb run test-demo
```

This demo will run a few tests: 
1. Deploy multisig contract : Will fail on invalid signatures
2. Execute multisig tx : 1 of 1, 1 of n, m of n
3. Sign simple transfers with various signature types and various threshholds.



