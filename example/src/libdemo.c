#include <stdio.h>
int compute(int a, int b) {
    int result = a * b + a;
    printf("[libdemo] compute(%d, %d) = %d\n", a, b, result);
    // 第5次调用时崩溃
    if (a >= 5) {
        printf("[libdemo] About to crash!\n");
        int *p = NULL;
        *p = 42;
    }
    return result;
}
