/**
 * 日出日落计算（NOAA Solar Position Algorithm）
 *
 * 零依赖实现，基于 NOAA 日照算法。输入日期 + 经纬度，
 * 返回当日日出/日落时刻（本地时区 Date 对象）。
 *
 * 参考：https://gml.noaa.gov/grad/solcalc/calcdetails.html
 */

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** 将日历日期转换为儒略日（Julian Day） */
function toJulianDay(date: Date): number {
  // 取本地日期分量，时分秒忽略（日出日落按天计算）。
  // 必须用本地日期而非 UTC 日期：用户关心的是「我所在本地日期的日出日落」，
  // 若用 getUTCDate()，在本地时间与 UTC 日期不一致时（如 UTC+8 凌晨 0-8 点，
  // UTC 仍是前一天），会算出前一天 UTC 的日出日落，导致 isDaytime 误判、
  // 跨过本地日出/日落时刻时主题不切换。
  const y = date.getFullYear()
  const m = date.getMonth() + 1
  const d = date.getDate()
  let yy = y
  let mm = m
  if (m <= 2) {
    yy -= 1
    mm += 12
  }
  const a = Math.floor(yy / 100)
  const b = 2 - a + Math.floor(a / 4)
  return Math.floor(365.25 * (yy + 4716)) + Math.floor(30.6001 * (mm + 1)) + d + b - 1524.5
}

/** 计算 Julian Century（自 J2000.0 起的世纪数） */
function toJulianCentury(jd: number): number {
  return (jd - 2451545.0) / 36525.0
}

/** NOAA 太阳平黄经（mean longitude） */
function sunMeanLongitude(t: number): number {
  const l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360
  return l < 0 ? l + 360 : l
}

/** NOAA 太阳平近点角（mean anomaly） */
function sunMeanAnomaly(t: number): number {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t)
}

/** NOAA 地球轨道偏心率 */
function earthEccentricity(t: number): number {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
}

/** NOAA 太阳方程中心（equation of center） */
function sunEquationOfCenter(t: number, m: number): number {
  const mr = m * RAD
  return (
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289
  )
}

/** 计算给定太阳天顶角对应的时角（hour angle） */
function hourAngle(lat: number, solarDec: number, zenith: number): number | null {
  const latR = lat * RAD
  const decR = solarDec * RAD
  const zenR = zenith * RAD
  const cosH =
    (Math.cos(zenR) - Math.sin(latR) * Math.sin(decR)) / (Math.cos(latR) * Math.cos(decR))
  // 极昼/极夜：超出 [-1, 1] 范围，无日出或日落
  if (cosH > 1 || cosH < -1) return null
  return Math.acos(cosH) * DEG
}

/** 计算时差（equation of time），单位分钟 */
function equationOfTime(t: number): number {
  const epsilon = (23.439291 - 0.0130042 * t) * RAD
  const l = sunMeanLongitude(t) * RAD
  const e = earthEccentricity(t)
  const m = sunMeanAnomaly(t) * RAD
  const y = Math.tan(epsilon / 2) ** 2
  const sin2l = Math.sin(2 * l)
  const cos2l = Math.cos(2 * l)
  const sin4l = Math.sin(4 * l)
  const sin2m = Math.sin(2 * m)
  return (
    y * sin2l -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * cos2l -
    0.5 * y * y * sin4l -
    1.25 * e * e * sin2m
  ) * DEG * 4 // 弧度→度→分钟
}

/** 计算太阳赤纬（declination），单位度 */
function solarDeclination(t: number): number {
  const l = sunMeanLongitude(t)
  const m = sunMeanAnomaly(t)
  const c = sunEquationOfCenter(t, m)
  const trueLong = l + c // 太阳真黄经
  // 赤纬 = 真黄经 在黄赤交角下的投影
  const epsilon = (23.439291 - 0.0130042 * t) * RAD
  return Math.asin(Math.sin(trueLong * RAD) * Math.sin(epsilon)) * DEG
}

/**
 * 给定日期 + 经纬度，返回当日日出日落时刻（本地时区 Date 对象）
 *
 * 极昼（夏极圈）或极夜（冬极圈）时对应项返回 null。
 *
 * @param zenith 太阳天顶角，官方日出日落用 90.833°（含大气折射 + 太阳半径补偿）
 */
export function getSunriseSunset(
  date: Date,
  lat: number,
  lng: number,
  zenith = 90.833,
): { sunrise: Date | null; sunset: Date | null } {
  const jd = toJulianDay(date)
  const t = toJulianCentury(jd)
  const dec = solarDeclination(t)
  const eot = equationOfTime(t) // 分钟

  const ha = hourAngle(lat, dec, zenith)
  if (ha === null) {
    // 极昼返回两个 null（无日出日落）；极夜同理
    return { sunrise: null, sunset: null }
  }

  // 日出/日落的太阳子午圈时角（度），再换算到本地时
  const noonMin = (720 - 4 * lng - eot) % 1440 // 太阳正午（UTC 分钟）
  const sunriseMin = noonMin - 4 * ha
  const sunsetMin = noonMin + 4 * ha

  // 用本地日期分量构造，但 noonMin/sunriseMin/sunsetMin 是 UTC 分钟。
  // Date.UTC 把 (本地日期 + UTC 时刻) 拼成绝对时间戳：sunrise/sunset 落在
  // 用户本地日期对应的那一天，与 new Date() 比较时区一致。
  // 旧实现用 getUTCFullYear/getUTCMonth/getUTCDate，在本地时间与 UTC 日期
  // 不一致时（如 UTC+8 凌晨）会取到前一天的日出日落，导致 isDaytime 误判。
  const y = date.getFullYear()
  const mo = date.getMonth()
  const d = date.getDate()

  const toLocalDate = (totalMin: number): Date => {
    let dayOffset = 0
    let m = totalMin % 1440
    if (m < 0) {
      m += 1440
      dayOffset = -1
    } else if (m >= 1440) {
      // 极少出现，但保留健壮性
      dayOffset = 1
    }
    const hh = Math.floor(m / 60)
    const mm = Math.floor(m % 60)
    const dt = new Date(Date.UTC(y, mo, d + dayOffset, hh, mm, 0))
    return dt
  }

  return {
    sunrise: toLocalDate(sunriseMin),
    sunset: toLocalDate(sunsetMin),
  }
}

/**
 * 当前时刻是否处于白天（日出后、日落前）
 *
 * 极昼恒返回 true，极夜恒返回 false；
 * 其他情况比较当前时刻与今日日出日落。
 * 极昼/极夜判定：getSunriseSunset 返回 null 时，按纬度 + 月份近似——
 * 若无日出日落且当前为夏季半球则视为极昼白天，否则极夜。
 */
export function isDaytime(lat: number, lng: number, now: Date = new Date()): boolean {
  const { sunrise, sunset } = getSunriseSunset(now, lat, lng)
  if (!sunrise || !sunset) {
    // 极昼/极夜 fallback：北半球 4-9 月、南半球 10-3 月视为白天（极昼）
    // 用本地月份与 getSunriseSunset 内部的本地日期分量对齐，避免时区边界月份错位
    const month = now.getMonth() + 1
    const northSummer = month >= 4 && month <= 9
    const isNorth = lat >= 0
    return isNorth ? northSummer : !northSummer
  }
  return now >= sunrise && now < sunset
}

/**
 * 给定位置，返回下一次日夜切换的时刻（用于 UI 预览「下次切换」）
 *
 * 若当前为白天，返回今日日落；若当前为夜晚，返回今日日出（若已过则明日日出）。
 */
export function nextTransition(lat: number, lng: number, now: Date = new Date()): { at: Date; to: 'light' | 'dark' } | null {
  const { sunrise, sunset } = getSunriseSunset(now, lat, lng)
  if (!sunrise || !sunset) return null
  if (now < sunrise) return { at: sunrise, to: 'light' }
  if (now < sunset) return { at: sunset, to: 'dark' }
  // 已过日落 → 明日日出
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const next = getSunriseSunset(tomorrow, lat, lng)
  return next.sunrise ? { at: next.sunrise, to: 'light' } : null
}
