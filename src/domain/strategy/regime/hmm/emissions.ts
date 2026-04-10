import type {
  HmmObservation,
  StudentTEmissionParams,
} from './types.js'

const EPSILON = 1e-12

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ]

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value)
  }

  const shifted = value - 1
  let accumulator = 0.9999999999998099
  for (let index = 0; index < coefficients.length; index += 1) {
    accumulator += coefficients[index] / (shifted + index + 1)
  }

  const base = shifted + coefficients.length - 0.5
  return (
    0.5 * Math.log(2 * Math.PI)
    + (shifted + 0.5) * Math.log(base)
    - base
    + Math.log(accumulator)
  )
}

export function studentTLogPdf(
  value: number,
  mu: number,
  sigma: number,
  nu: number,
): number {
  const safeSigma = Math.max(Math.abs(sigma), EPSILON)
  const safeNu = Math.max(nu, 2.1)
  const scaledDistance = ((value - mu) ** 2) / (safeNu * safeSigma ** 2)
  const constant =
    logGamma((safeNu + 1) / 2)
    - logGamma(safeNu / 2)
    - 0.5 * Math.log(safeNu * Math.PI * safeSigma ** 2)
  return constant - ((safeNu + 1) / 2) * Math.log(1 + scaledDistance)
}

export function observationToVector(observation: HmmObservation): [number, number, number] {
  return [
    observation.return1h,
    observation.realizedVol,
    observation.volumeChangeRate,
  ]
}

export function mahalanobisDistanceSquared(
  observation: HmmObservation,
  emission: StudentTEmissionParams,
): number {
  const vector = observationToVector(observation)
  return vector.reduce((sum, value, dimension) => {
    const sigma = Math.max(Math.abs(emission.sigma[dimension]), EPSILON)
    return sum + ((value - emission.mu[dimension]) / sigma) ** 2
  }, 0)
}

export function scaleMixtureWeight(
  observation: HmmObservation,
  emission: StudentTEmissionParams,
): number {
  const distance = mahalanobisDistanceSquared(observation, emission)
  return (Math.max(emission.nu, 2.1) + 3) / (Math.max(emission.nu, 2.1) + distance)
}

export function multivariateStudentTLogLikelihood(
  observation: HmmObservation,
  emission: StudentTEmissionParams,
): number {
  const vector = observationToVector(observation)
  return vector.reduce((sum, value, dimension) => (
    sum + studentTLogPdf(value, emission.mu[dimension], emission.sigma[dimension], emission.nu)
  ), 0)
}
