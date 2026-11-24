//----------------------------------------------------------------------------------------------------------------------
/// Tricky but valid code that should not produce false positives.
///
/// Author: 12345678
//----------------------------------------------------------------------------------------------------------------------

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "helpers.h"

#define BUFFER_SIZE 64
#define SQUARE(value) ((value) * (value))

typedef int (*Comparator)(const void*, const void*);

typedef struct _Point_
{
  int x_coordinate_;
  int y_coordinate_;
} Point;

//----------------------------------------------------------------------------------------------------------------------
/// @brief Compares two integers for qsort.
/// @param first_value pointer to the first integer
/// @param second_value pointer to the second integer
/// @return negative, zero or positive
int compareIntegers(const void* first_value, const void* second_value)
{
  const int* first = (const int*)first_value;
  const int* second = (const int*)second_value;
  return *first - *second;
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Demonstrates operators that look binary but are unary.
/// @param point the point to use
/// @param values an array of values
/// @param length length of the array
/// @param compare comparison function
/// @return a computed number
int useOperators(Point* point, int* values, size_t length, int (*compare)(const void*, const void*))
{
  int negative = -point->x_coordinate_;
  int product = point->x_coordinate_ * point->y_coordinate_;
  int* address = &product;
  int dereferenced = *address;
  int maximum = product > negative ? product : negative;
  size_t size = sizeof(int) * length;
  double ratio = (double)product / (double)length;
  qsort(values, length, sizeof *values, compare);
  values[0] = -values[0] * -1;
  dereferenced++;
  --dereferenced;
  char text[BUFFER_SIZE] = "";
  strcpy(text, "hello");
  Point origin = {0, 0};
  Point copy = *point;
  copy.x_coordinate_ += origin.x_coordinate_;
  printf("%zu %f %d %s\n", size, ratio, SQUARE(maximum), text);
  return (int)(dereferenced + copy.x_coordinate_);
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Reads numbers until the user enters zero.
/// @return the sum of all numbers
int readSum(void)
{
  int sum = 0;
  int number_read = 0;
  while (scanf("%d", &number_read) == 1 && number_read != 0)
    sum += number_read;
  if (sum < 0 ||
      sum == 0)
  {
    return 0;
  }
  return sum;
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Entry point.
/// @return exit code of the program
int main(void)
{
  int values[] = {3, 1, 2};
  Point point = {1, 0};
  Comparator comparator = compareIntegers;
  int result = useOperators(&point, values, sizeof(values) / sizeof(values[0]), comparator);
  printf("%d %d\n", result, readSum());
  return 0;
}
