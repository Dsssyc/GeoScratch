export function randomNonZeroBetweenMinusOneAndOne(excludeRadius) {
    let result;
    do {
      result = Math.random() * 2 - 1;
    } while (Math.abs(result) < excludeRadius); // 排除靠近0的小区间
    return result;
}