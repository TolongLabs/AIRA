import type { SearchField } from '../src/tools/search-depth.js'

export interface SearchCase {
  id: string
  query: string
  localQuery: string
  fields: SearchField[]
  host: string
}

export const plainQueries = [
  'merlion height',
  'Petronas Towers height',
  'population of Ipoh',
  'Penang area',
  'Kuala Lumpur founding date',
  'Minecraft Java 1.21 release date',
  'Singapore MRT first opening',
  'Mount Kinabalu height',
  'Malaysian ringgit symbol',
  'Malaysia national flower'
]

export const searchCases: SearchCase[] = [
  {
    id: 'cafe-menu',
    query: 'site:starbucks.com Singapore Starbucks menu coffee latte cappuccino croissant food menu',
    localQuery: 'site:starbucks.com Starbucks menu cappuccino flat white croissant sandwich cold brew',
    fields: [
      { kind: 'list', subject: 'Starbucks breakfast food', aliases: ['breakfast', 'bakery', 'croissants'] },
      { kind: 'list', subject: 'Starbucks cold drinks', aliases: ['cold brew', 'iced espresso'] }
    ],
    host: 'starbucks.com'
  },
  {
    id: 'fast-food-menu',
    query: 'site:mcdonalds.com US McDonald’s menu McCafé burger fries menu items',
    localQuery: 'site:mcdonalds.com McDonald’s full menu Big Mac fries iced coffee USA',
    fields: [{ kind: 'list', subject: 'McDonald’s menu' }],
    host: 'mcdonalds.com'
  },
  {
    id: 'japan-menu',
    query: 'site:starbucks.co.jp Starbucks Japan regular coffee drink menu',
    localQuery: 'site:starbucks.co.jp スターバックス ドリンク メニュー 定番 コーヒー',
    fields: [{ kind: 'list', subject: 'Starbucks Japan menu', aliases: ['スターバックス'] }],
    host: 'starbucks.co.jp'
  },
  {
    id: 'tea-menu',
    query: 'site:gong-cha.com Gong Cha milk tea menu drinks',
    localQuery: 'site:gong-cha.com Gong Cha menu pearl milk tea taro matcha',
    fields: [{ kind: 'list', subject: 'Gong Cha menu' }],
    host: 'gong-cha.com'
  },
  {
    id: 'museum-price',
    query: 'site:gardensbythebay.com.sg Cloud Forest adult admission price Singapore',
    localQuery: 'site:gardensbythebay.com.sg Gardens by the Bay Cloud Forest adult admission SGD fare ticket',
    fields: [{ kind: 'price', subject: 'Cloud Forest', aliases: ['Cloud Forest admission'] }],
    host: 'gardensbythebay.com.sg'
  },
  {
    id: 'hardware-price',
    query: 'site:raspberrypi.com Raspberry Pi Zero 2 W price USD',
    localQuery: 'site:raspberrypi.com Raspberry Pi Zero 2 W $15 price board official',
    fields: [{ kind: 'price', subject: 'Raspberry Pi Zero 2 W' }],
    host: 'raspberrypi.com'
  },
  {
    id: 'rail-price',
    query: 'site:tokyometro.jp Tokyo Subway Ticket 24-hour adult price',
    localQuery: 'site:tokyometro.jp 東京 東京メトロ 24時間券 大人 料金 円',
    fields: [{ kind: 'price', subject: '24-hour ticket', aliases: ['24時間券', '24-hour'] }],
    host: 'tokyometro.jp'
  },
  {
    id: 'park-price',
    query: 'site:nps.gov Yellowstone private vehicle entrance pass price',
    localQuery: 'site:nps.gov Yellowstone National Park standard entrance pass private vehicle $35',
    fields: [{ kind: 'price', subject: 'private vehicle', aliases: ['vehicle pass'] }],
    host: 'nps.gov'
  },
  {
    id: 'garden-hours',
    query: 'site:gardensbythebay.com.sg Flower Dome opening hours',
    localQuery: 'site:gardensbythebay.com.sg Flower Dome opening hours daily Singapore',
    fields: [{ kind: 'hours', subject: 'Flower Dome' }],
    host: 'gardensbythebay.com.sg'
  },
  {
    id: 'cloud-forest-hours',
    query: 'site:gardensbythebay.com.sg Cloud Forest daily opening hours',
    localQuery: 'site:gardensbythebay.com.sg Cloud Forest waktu buka setiap hari Singapore',
    fields: [{ kind: 'hours', subject: 'Cloud Forest' }],
    host: 'gardensbythebay.com.sg'
  },
  {
    id: 'release-date',
    query: 'site:minecraft.net Minecraft Java Edition 1.21 release date Tricky Trials',
    localQuery: 'site:minecraft.net Minecraft Java Edition 1.21 Tricky Trials released June 2024',
    fields: [{ kind: 'other', subject: 'Java Edition 1.21', aliases: ['Tricky Trials release'] }],
    host: 'minecraft.net'
  },
  {
    id: 'measurement',
    query: 'site:stb.gov.sg Merlion height in metres',
    localQuery: 'site:stb.gov.sg Merlion 8.6 metres tall Merlion Park Singapore',
    fields: [{ kind: 'other', subject: 'Merlion height', aliases: ['Merlion metres tall', 'Merlion meters tall'] }],
    host: 'stb.gov.sg'
  }
]
