const { getNamedAccounts, deployments, ethers, network } = require('hardhat')
const { developmentChains, networkConfig } = require('../../helper-hardhat-config')
const { assert, expect } = require('chai')

!developmentChains.includes(network.name)
    ? describe.skip
    : describe('Raffle Unit Tests', () => {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async () => {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(['all'])
              raffle = await ethers.getContract('Raffle', deployer)
              vrfCoordinatorV2Mock = await ethers.getContract('VRFCoordinatorV2Mock', deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })

          describe('constructor', () => {
              it('Should initialize the raffle correctly', async () => {
                  // Ideally we make our tests have just 1 assert per "it()"
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), '0')
                  assert.equal(interval.toString(), networkConfig[chainId]['interval'])
              })
          })

          describe('enterRaffle', () => {
              it('Should revert when not paying enough', async () => {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      'Raffle__SendMoreToEnterRaffle'
                  )
              })
              it('Should record player when joins raffle', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const playerFromContract = await raffle.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("Should emit 'RaffleEnter' event on enter", async () => {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      'RaffleEnter'
                  )
              })
              it('Should allow entrace when raffle is calculating', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  // We pretend to be a Chainlink Keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      'Raffle__RaffleNotOpen'
                  )
              })
          })
          describe('checkUpkeep', () => {
              it("Should return false if people haven't send any ETH", async () => {
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  /* checkUpkeep now is a view function so it doesn't need a tx
                    but if it was just public the function thinks we wanna send a tx
                    to simulate that transaction we can use the callStatic method
                    await raffle.callStatic.checkUpkeep([])
                */
                  const { upkeepNeeded } = await raffle.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it('Should return false if raffle is not open', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  await raffle.performUpkeep([]) // other way to send a blank object is to do "0x" instead of "[]"
                  const raffleState = await raffle.getRaffleState()
                  const { upkeepNeeded } = await raffle.checkUpkeep([])
                  assert.equal(raffleState.toString(), '1')
                  assert.equal(upkeepNeeded, false)
              })
              it("Should return false if enough time hasn't passed", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() - 5]) // use a higher number here if this test fails
                  await network.provider.request({ method: 'evm_mine', params: [] }) // this is the same as writing "await network.provider.send('evm_mine', [])"
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep('0x') // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert(!upkeepNeeded)
              })
              it('Should return true if has players, raffle is open and enough time has passed', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  const { upkeepNeeded } = await raffle.checkUpkeep([])
                  assert(upkeepNeeded)
              })
          })

          describe('performUpkeep', () => {
              it('Should run if checkUpkeep return true', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  const tx = await raffle.performUpkeep([]) // if tx doesn't work it means the test is going to fail
                  assert(tx)
              })
              it('Should revert when checkUpkeep is false', async () => {
                  await expect(raffle.performUpkeep([])).to.be.revertedWith(
                      'Raffle__UpkeepNotNeeded' // we can be more specific and add the args of the error
                  )
              })
              it('Should update the raffle state, emits and event, and call the vrf coordinator', async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
                  const txResponse = await raffle.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const requestId = txReceipt.events[1].args.requestId
                  const raffleState = await raffle.getRaffleState()
                  assert(requestId.toNumber() > 0)
                  assert(raffleState.toString() === '1')
              })
          })

          describe('fulfillRandomWords', () => {
              beforeEach(async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send('evm_increaseTime', [interval.toNumber() + 1])
                  await network.provider.send('evm_mine', [])
              })
              it('Should only be called after performUpkeep', async () => {
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address) // reverts if not fulfilled
                  ).to.be.revertedWith('nonexistent request')
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address) // reverts if not fulfilled
                  ).to.be.revertedWith('nonexistent request')
              })
              it('Should pick a winner, reset the lottery and send money', async () => {
                  const additionalEntrants = 3
                  const startingAccountIndex = 1 // deployer = 0
                  const accounts = await ethers.getSigners()
                  for (
                      let i = startingAccountIndex;
                      i < startingAccountIndex + additionalEntrants;
                      i++
                  ) {
                      const accountConnectedRaffle = raffle.connect(accounts[i])
                      await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                  }
                  const startingTimeStamp = await raffle.getLastTimeStamp()

                  // performUpkeep (mock being chainlink keepers)
                  // fulfillRandomWords (mock being the Chainlink VRF)
                  // we will have to wait for the fulfillRandomWords to be called
                  // in order for us to simulate waiting for fulfillRandomWords we need to setup a listener (create a new Promise)
                  await new Promise(async (resolve, reject) => {
                      // Listener
                      raffle.once('WinnerPicked', async () => {
                          console.log('Found the event!')
                          try {
                              const recentWinner = await raffle.getRecentWinner() // it will be account 1
                              const raffleState = await raffle.getRaffleState()
                              const endingTimeStamp = await raffle.getLastTimeStamp()
                              const numPlayers = await raffle.getNumberOfPlayers()
                              const winnerEndingBalance = await accounts[1].getBalance()
                              assert.equal(numPlayers.toString(), '0')
                              assert.equal(raffleState.toString(), '0')
                              assert(endingTimeStamp > startingTimeStamp)

                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance.add(
                                      raffleEntranceFee
                                          .mul(additionalEntrants)
                                          .add(raffleEntranceFee)
                                          .toString()
                                  )
                              )
                          } catch (e) {
                              reject(e)
                          }
                          resolve()
                      })
                      // Setting up the listener
                      // below, we will fire the event, and the listener will pick it up and resolve
                      const tx = await raffle.performUpkeep([])
                      const txReceipt = await tx.wait(1)
                      const winnerStartingBalance = await accounts[1].getBalance()
                      await vrfCoordinatorV2Mock.fulfillRandomWords(
                          txReceipt.events[1].args.requestId,
                          raffle.address
                      )
                  })
              })
          })
      })
