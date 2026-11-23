import type { OrderDetails, ProductDetails } from '../../domain/model.js'
import { toNumber } from './numbers.js'
import type { WaOrder, WaProduct } from './wa-types.js'

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value

/** An amount that the platform sends in thousandths, in currency units. */
const unitsOf = (thousandths: Parameters<typeof toNumber>[0]): number | null => {
  const n = toNumber(thousandths)
  return n === null ? null : n / 1000
}

export function orderOf(order: WaOrder | null | undefined): OrderDetails | null {
  if (!order) return null
  return {
    orderId: text(order.orderId),
    itemCount: order.itemCount ?? null,
    totalAmount: unitsOf(order.totalAmount1000),
    currency: text(order.totalCurrencyCode),
    title: text(order.orderTitle),
    message: text(order.message),
  }
}

export function productOf(product: WaProduct | null | undefined): ProductDetails | null {
  if (!product) return null
  return {
    productId: text(product.productId),
    title: text(product.title),
    price: unitsOf(product.priceAmount1000),
    currency: text(product.currencyCode),
    retailerId: text(product.retailerId),
  }
}

/** An amount with its currency in the language of the account ("$ 12.000", "ARS 12.000"), or null without an amount. */
export function moneyText(amount: number | null, currency: string | null, locale: string): string | null {
  if (amount === null) return null
  try {
    return new Intl.NumberFormat(locale, {
      ...(currency === null ? {} : { style: 'currency', currency }),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return currency === null ? String(amount) : `${amount} ${currency}`
  }
}
