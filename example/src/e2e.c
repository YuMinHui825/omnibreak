#include <stdio.h>
int main() {
    setbuf(stdout, NULL);
    int x = 10, y = 20;
    int sum = x + y;
    printf("E2E OK: %d\n", sum);
    return 0;
}
