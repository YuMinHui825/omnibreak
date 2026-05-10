cmake_minimum_required(VERSION 3.16)
project(RobotDebugExample C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_FLAGS_DEBUG "-Og -g -ggdb3 -fno-omit-frame-pointer")

add_executable(hello src/hello.c)
add_executable(multithread src/multithread.c)
target_link_libraries(multithread pthread)
