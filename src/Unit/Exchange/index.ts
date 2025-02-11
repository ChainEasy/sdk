import type Unit from '../index.js';
import deposit, { type DepositParams } from './deposit.js';
import getSwapInfo, { type GetSwapInfoParams } from './getSwapInfo.js';
import type { SwapLimitParams } from './swapLimit.js';
import swapLimit from './swapLimit.js';
import swapMarket, { type SwapMarketParams } from './swapMarket.js';
import withdraw, { type WithdrawParams } from './withdraw.js';

type PureSwapMarketParams = Omit<SwapMarketParams, 'unit'>
type PureSwapLimitParams = Omit<SwapLimitParams, 'unit'>
type PureDepositParams = Omit<DepositParams, 'unit'>
type PureWithdrawParams = Omit<WithdrawParams, 'unit'>
type PureGetSwapMarketInfoParams = Omit<GetSwapInfoParams, 'blockchainService' | 'aggregator'>

export default class Exchange {
  private readonly unit: Unit;

  constructor(unit: Unit) {
    this.unit = unit;
  }

  public swapLimit(params: PureSwapLimitParams) {
    return swapLimit({
      ...params,
      unit: this.unit,
    });
  }

  public swapMarket(params: PureSwapMarketParams) {
    return swapMarket({
      ...params,
      unit: this.unit,
    });
  }

  public getSwapInfo(params: PureGetSwapMarketInfoParams) {
    return getSwapInfo({
      aggregator: this.unit.aggregator,
      blockchainService: this.unit.blockchainService,
      ...params,
    });
  }

  public deposit(params: PureDepositParams) {
    return deposit({
      ...params,
      unit: this.unit,
    });
  }

  public withdraw(params: PureWithdrawParams) {
    return withdraw({
      ...params,
      unit: this.unit,
    });
  }
}
