/**
 * 内置城市经纬度表
 *
 * 用于「日出日落」主题模式的位置选择。覆盖全球主要城市，
 * 按国家/地区分组，每条记录含名称、纬度、经度。
 * 数据为公开地理坐标，精度到 0.01°（约 1km），足够日出日落计算。
 */

export interface City {
  name: string
  /** 纬度（北正南负） */
  lat: number
  /** 经度（东正西负） */
  lng: number
  /** 国家/地区 */
  country: string
}

export const CITIES: readonly City[] = [
  // ===== 中国 =====
  { name: '北京', lat: 39.90, lng: 116.41, country: '中国' },
  { name: '上海', lat: 31.23, lng: 121.47, country: '中国' },
  { name: '广州', lat: 23.13, lng: 113.26, country: '中国' },
  { name: '深圳', lat: 22.54, lng: 114.06, country: '中国' },
  { name: '成都', lat: 30.67, lng: 104.07, country: '中国' },
  { name: '重庆', lat: 29.56, lng: 106.55, country: '中国' },
  { name: '杭州', lat: 30.27, lng: 120.15, country: '中国' },
  { name: '南京', lat: 32.06, lng: 118.80, country: '中国' },
  { name: '武汉', lat: 30.59, lng: 114.31, country: '中国' },
  { name: '西安', lat: 34.34, lng: 108.94, country: '中国' },
  { name: '天津', lat: 39.08, lng: 117.20, country: '中国' },
  { name: '苏州', lat: 31.30, lng: 120.62, country: '中国' },
  { name: '长沙', lat: 28.23, lng: 112.94, country: '中国' },
  { name: '青岛', lat: 36.07, lng: 120.38, country: '中国' },
  { name: '郑州', lat: 34.75, lng: 113.62, country: '中国' },
  { name: '沈阳', lat: 41.80, lng: 123.43, country: '中国' },
  { name: '大连', lat: 38.91, lng: 121.60, country: '中国' },
  { name: '哈尔滨', lat: 45.80, lng: 126.53, country: '中国' },
  { name: '济南', lat: 36.65, lng: 117.00, country: '中国' },
  { name: '昆明', lat: 25.04, lng: 102.71, country: '中国' },
  { name: '南宁', lat: 22.82, lng: 108.37, country: '中国' },
  { name: '福州', lat: 26.07, lng: 119.30, country: '中国' },
  { name: '厦门', lat: 24.48, lng: 118.09, country: '中国' },
  { name: '合肥', lat: 31.82, lng: 117.23, country: '中国' },
  { name: '南昌', lat: 28.68, lng: 115.86, country: '中国' },
  { name: '太原', lat: 37.87, lng: 112.55, country: '中国' },
  { name: '石家庄', lat: 38.04, lng: 114.51, country: '中国' },
  { name: '兰州', lat: 36.06, lng: 103.83, country: '中国' },
  { name: '海口', lat: 20.04, lng: 110.20, country: '中国' },
  { name: '贵阳', lat: 26.65, lng: 106.71, country: '中国' },
  { name: '拉萨', lat: 29.65, lng: 91.11, country: '中国' },
  { name: '乌鲁木齐', lat: 43.83, lng: 87.62, country: '中国' },
  { name: '呼和浩特', lat: 40.84, lng: 111.75, country: '中国' },
  { name: '银川', lat: 38.49, lng: 106.21, country: '中国' },
  { name: '西宁', lat: 36.62, lng: 101.78, country: '中国' },
  { name: '香港', lat: 22.32, lng: 114.17, country: '中国' },
  { name: '台北', lat: 25.03, lng: 121.57, country: '中国' },
  { name: '澳门', lat: 22.20, lng: 113.55, country: '中国' },

  // ===== 东亚其他 =====
  { name: '东京', lat: 35.68, lng: 139.69, country: '日本' },
  { name: '大阪', lat: 34.69, lng: 135.50, country: '日本' },
  { name: '名古屋', lat: 35.18, lng: 136.91, country: '日本' },
  { name: '札幌', lat: 43.06, lng: 141.35, country: '日本' },
  { name: '福冈', lat: 33.59, lng: 130.40, country: '日本' },
  { name: '首尔', lat: 37.57, lng: 126.98, country: '韩国' },
  { name: '釜山', lat: 35.18, lng: 129.08, country: '韩国' },
  { name: '平壤', lat: 39.02, lng: 125.75, country: '朝鲜' },
  { name: '乌兰巴托', lat: 47.92, lng: 106.92, country: '蒙古' },

  // ===== 东南亚 =====
  { name: '新加坡', lat: 1.35, lng: 103.82, country: '新加坡' },
  { name: '曼谷', lat: 13.76, lng: 100.50, country: '泰国' },
  { name: '吉隆坡', lat: 3.14, lng: 101.69, country: '马来西亚' },
  { name: '雅加达', lat: -6.21, lng: 106.85, country: '印度尼西亚' },
  { name: '马尼拉', lat: 14.60, lng: 120.98, country: '菲律宾' },
  { name: '河内', lat: 21.03, lng: 105.85, country: '越南' },
  { name: '胡志明市', lat: 10.82, lng: 106.63, country: '越南' },
  { name: '金边', lat: 11.56, lng: 104.93, country: '柬埔寨' },
  { name: '仰光', lat: 16.84, lng: 96.17, country: '缅甸' },
  { name: '万象', lat: 17.97, lng: 102.63, country: '老挝' },

  // ===== 南亚 =====
  { name: '新德里', lat: 28.61, lng: 77.21, country: '印度' },
  { name: '孟买', lat: 19.08, lng: 72.88, country: '印度' },
  { name: '加尔各答', lat: 22.57, lng: 88.36, country: '印度' },
  { name: '班加罗尔', lat: 12.97, lng: 77.59, country: '印度' },
  { name: '金奈', lat: 13.08, lng: 80.27, country: '印度' },
  { name: '卡拉奇', lat: 24.86, lng: 67.01, country: '巴基斯坦' },
  { name: '伊斯兰堡', lat: 33.69, lng: 73.05, country: '巴基斯坦' },
  { name: '达卡', lat: 23.81, lng: 90.41, country: '孟加拉国' },
  { name: '科伦坡', lat: 6.93, lng: 79.86, country: '斯里兰卡' },
  { name: '加德满都', lat: 27.71, lng: 85.32, country: '尼泊尔' },

  // ===== 中亚 / 西亚 =====
  { name: '迪拜', lat: 25.20, lng: 55.27, country: '阿联酋' },
  { name: '阿布扎比', lat: 24.45, lng: 54.38, country: '阿联酋' },
  { name: '多哈', lat: 25.29, lng: 51.21, country: '卡塔尔' },
  { name: '利雅得', lat: 24.71, lng: 46.68, country: '沙特阿拉伯' },
  { name: '德黑兰', lat: 35.70, lng: 51.39, country: '伊朗' },
  { name: '巴格达', lat: 33.31, lng: 44.36, country: '伊拉克' },
  { name: '安卡拉', lat: 39.93, lng: 32.86, country: '土耳其' },
  { name: '伊斯坦布尔', lat: 41.01, lng: 28.98, country: '土耳其' },
  { name: '耶路撒冷', lat: 31.78, lng: 35.22, country: '以色列' },
  { name: '特拉维夫', lat: 32.08, lng: 34.78, country: '以色列' },
  { name: '贝鲁特', lat: 33.89, lng: 35.50, country: '黎巴嫩' },
  { name: '大马士革', lat: 33.51, lng: 36.29, country: '叙利亚' },
  { name: '阿斯塔纳', lat: 51.16, lng: 71.43, country: '哈萨克斯坦' },
  { name: '塔什干', lat: 41.31, lng: 69.24, country: '乌兹别克斯坦' },

  // ===== 欧洲 =====
  { name: '伦敦', lat: 51.51, lng: -0.13, country: '英国' },
  { name: '爱丁堡', lat: 55.95, lng: -3.19, country: '英国' },
  { name: '都柏林', lat: 53.35, lng: -6.26, country: '爱尔兰' },
  { name: '巴黎', lat: 48.86, lng: 2.35, country: '法国' },
  { name: '马赛', lat: 43.30, lng: 5.37, country: '法国' },
  { name: '柏林', lat: 52.52, lng: 13.40, country: '德国' },
  { name: '慕尼黑', lat: 48.14, lng: 11.58, country: '德国' },
  { name: '法兰克福', lat: 50.11, lng: 8.68, country: '德国' },
  { name: '罗马', lat: 41.90, lng: 12.50, country: '意大利' },
  { name: '米兰', lat: 45.46, lng: 9.19, country: '意大利' },
  { name: '马德里', lat: 40.42, lng: -3.70, country: '西班牙' },
  { name: '巴塞罗那', lat: 41.39, lng: 2.17, country: '西班牙' },
  { name: '里斯本', lat: 38.72, lng: -9.14, country: '葡萄牙' },
  { name: '阿姆斯特丹', lat: 52.37, lng: 4.90, country: '荷兰' },
  { name: '布鲁塞尔', lat: 50.85, lng: 4.35, country: '比利时' },
  { name: '维也纳', lat: 48.21, lng: 16.37, country: '奥地利' },
  { name: '苏黎世', lat: 47.38, lng: 8.54, country: '瑞士' },
  { name: '日内瓦', lat: 46.20, lng: 6.14, country: '瑞士' },
  { name: '哥本哈根', lat: 55.68, lng: 12.57, country: '丹麦' },
  { name: '斯德哥尔摩', lat: 59.33, lng: 18.07, country: '瑞典' },
  { name: '奥斯陆', lat: 59.91, lng: 10.75, country: '挪威' },
  { name: '赫尔辛基', lat: 60.17, lng: 24.94, country: '芬兰' },
  { name: '雷克雅未克', lat: 64.15, lng: -21.94, country: '冰岛' },
  { name: '华沙', lat: 52.23, lng: 21.01, country: '波兰' },
  { name: '布拉格', lat: 50.08, lng: 14.44, country: '捷克' },
  { name: '布达佩斯', lat: 47.50, lng: 19.04, country: '匈牙利' },
  { name: '雅典', lat: 37.98, lng: 23.73, country: '希腊' },
  { name: '莫斯科', lat: 55.76, lng: 37.62, country: '俄罗斯' },
  { name: '圣彼得堡', lat: 59.93, lng: 30.34, country: '俄罗斯' },
  { name: '基辅', lat: 50.45, lng: 30.52, country: '乌克兰' },
  { name: '布加勒斯特', lat: 44.43, lng: 26.10, country: '罗马尼亚' },
  { name: '索菲亚', lat: 42.70, lng: 23.32, country: '保加利亚' },
  { name: '贝尔格莱德', lat: 44.79, lng: 20.46, country: '塞尔维亚' },

  // ===== 北美 =====
  { name: '纽约', lat: 40.71, lng: -74.01, country: '美国' },
  { name: '洛杉矶', lat: 34.05, lng: -118.24, country: '美国' },
  { name: '芝加哥', lat: 41.88, lng: -87.63, country: '美国' },
  { name: '休斯顿', lat: 29.76, lng: -95.37, country: '美国' },
  { name: '凤凰城', lat: 33.45, lng: -112.07, country: '美国' },
  { name: '费城', lat: 39.95, lng: -75.17, country: '美国' },
  { name: '旧金山', lat: 37.77, lng: -122.42, country: '美国' },
  { name: '西雅图', lat: 47.61, lng: -122.33, country: '美国' },
  { name: '波士顿', lat: 42.36, lng: -71.06, country: '美国' },
  { name: '丹佛', lat: 39.74, lng: -104.99, country: '美国' },
  { name: '迈阿密', lat: 25.76, lng: -80.19, country: '美国' },
  { name: '亚特兰大', lat: 33.75, lng: -84.39, country: '美国' },
  { name: '达拉斯', lat: 32.78, lng: -96.80, country: '美国' },
  { name: '华盛顿', lat: 38.91, lng: -77.04, country: '美国' },
  { name: '拉斯维加斯', lat: 36.17, lng: -115.14, country: '美国' },
  { name: '檀香山', lat: 21.31, lng: -157.86, country: '美国' },
  { name: '安克雷奇', lat: 61.22, lng: -149.90, country: '美国' },
  { name: '多伦多', lat: 43.65, lng: -79.38, country: '加拿大' },
  { name: '温哥华', lat: 49.28, lng: -123.12, country: '加拿大' },
  { name: '蒙特利尔', lat: 45.50, lng: -73.57, country: '加拿大' },
  { name: '卡尔加里', lat: 51.05, lng: -114.07, country: '加拿大' },
  { name: '渥太华', lat: 45.42, lng: -75.70, country: '加拿大' },
  { name: '埃德蒙顿', lat: 53.55, lng: -113.49, country: '加拿大' },
  { name: '墨西哥城', lat: 19.43, lng: -99.13, country: '墨西哥' },
  { name: '坎昆', lat: 21.16, lng: -86.85, country: '墨西哥' },

  // ===== 南美 =====
  { name: '圣保罗', lat: -23.55, lng: -46.63, country: '巴西' },
  { name: '里约热内卢', lat: -22.91, lng: -43.17, country: '巴西' },
  { name: '巴西利亚', lat: -15.79, lng: -47.88, country: '巴西' },
  { name: '布宜诺斯艾利斯', lat: -34.60, lng: -58.38, country: '阿根廷' },
  { name: '圣地亚哥', lat: -33.45, lng: -70.67, country: '智利' },
  { name: '利马', lat: -12.05, lng: -77.04, country: '秘鲁' },
  { name: '波哥大', lat: 4.71, lng: -74.07, country: '哥伦比亚' },
  { name: '基多', lat: -0.18, lng: -78.47, country: '厄瓜多尔' },
  { name: '加拉加斯', lat: 10.49, lng: -66.88, country: '委内瑞拉' },
  { name: '蒙得维的亚', lat: -34.90, lng: -56.16, country: '乌拉圭' },

  // ===== 大洋洲 =====
  { name: '悉尼', lat: -33.87, lng: 151.21, country: '澳大利亚' },
  { name: '墨尔本', lat: -37.81, lng: 144.96, country: '澳大利亚' },
  { name: '布里斯班', lat: -27.47, lng: 153.03, country: '澳大利亚' },
  { name: '珀斯', lat: -31.95, lng: 115.86, country: '澳大利亚' },
  { name: '阿德莱德', lat: -34.93, lng: 138.60, country: '澳大利亚' },
  { name: '堪培拉', lat: -35.28, lng: 149.13, country: '澳大利亚' },
  { name: '达尔文', lat: -12.46, lng: 130.84, country: '澳大利亚' },
  { name: '奥克兰', lat: -36.85, lng: 174.76, country: '新西兰' },
  { name: '惠灵顿', lat: -41.29, lng: 174.78, country: '新西兰' },

  // ===== 非洲 =====
  { name: '开罗', lat: 30.04, lng: 31.24, country: '埃及' },
  { name: '拉各斯', lat: 6.52, lng: 3.38, country: '尼日利亚' },
  { name: '内罗毕', lat: -1.29, lng: 36.82, country: '肯尼亚' },
  { name: '约翰内斯堡', lat: -26.20, lng: 28.05, country: '南非' },
  { name: '开普敦', lat: -33.92, lng: 18.42, country: '南非' },
  { name: '德班', lat: -29.86, lng: 31.03, country: '南非' },
  { name: '卡萨布兰卡', lat: 33.57, lng: -7.59, country: '摩洛哥' },
  { name: '阿尔及尔', lat: 36.75, lng: 3.06, country: '阿尔及利亚' },
  { name: '突尼斯', lat: 36.81, lng: 10.18, country: '突尼斯' },
  { name: '阿克拉', lat: 5.60, lng: -0.19, country: '加纳' },
  { name: '亚的斯亚贝巴', lat: 9.03, lng: 38.74, country: '埃塞俄比亚' },
  { name: '达累斯萨拉姆', lat: -6.82, lng: 39.30, country: '坦桑尼亚' },
  { name: '坎帕拉', lat: 0.35, lng: 32.58, country: '乌干达' },
  { name: '哈拉雷', lat: -17.83, lng: 31.05, country: '津巴布韦' },
  { name: '达喀尔', lat: 14.69, lng: -17.45, country: '塞内加尔' },
]

/** 按名称或国家模糊搜索城市 */
export function searchCities(query: string, limit = 20): City[] {
  const q = query.trim().toLowerCase()
  if (!q) return CITIES.slice(0, limit)
  return CITIES.filter(
    (c) => c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q),
  ).slice(0, limit)
}
