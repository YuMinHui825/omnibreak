#include <stdio.h>
#include <unistd.h>
extern int compute(int a, int b);
int main() {
    printf("[host] Started, PID=%d\n", getpid());
    int i = 1;
    while (1) {
        int r = compute(i, i * 10);
        printf("[host] i=%d got=%d\n", i, r);
        i++;
        sleep(2);
    }
    return 0;
}
