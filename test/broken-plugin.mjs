/** 测试用故障插件：导入成功、apply 抛错，模拟真实的插件冲突。 */
export const name = 'doctor-test-broken'

export function apply() {
  throw new Error('doctor-test-broken: intentional apply failure')
}
