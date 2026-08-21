/**
 * 默认住户的标识。
 *
 * 单独成一个不依赖任何东西的模块：建表语句和住户解析器都要用它，
 * 而解析器本身依赖建表模块，放在任何一边都会形成循环引用。
 */
export const DEFAULT_HOUSEHOLD_ID = "household-default";
