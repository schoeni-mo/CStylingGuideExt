//----------------------------------------------------------------------------------------------------------------------
/// Calculates statistics of a small inventory and prints them.
///
/// Author: 12345678
//----------------------------------------------------------------------------------------------------------------------

#include <stdio.h>
#include <stdlib.h>

#define MAX_ITEMS 10
#define PI 3.14159
const double RADIUS = 5.0;

typedef enum _MyBool_
{
  THIS_IS_FALSE = 0,
  THIS_IS_TRUE = 1
} MyBool;

typedef struct _Human_
{
  int age_;
  MyBool is_married_;
  struct _Human_* spouse_;
} Human;

//----------------------------------------------------------------------------------------------------------------------
/// @brief Returns the age of the spouse of a human.
/// @param human the human to check
/// @param number_to_return_if_not_married value returned if the human is not
///        married
/// @return the age of the spouse
int getAgeOfSpouse(Human* human, int number_to_return_if_not_married)
{
  if (human->is_married_ == THIS_IS_TRUE)
  {
    return human->spouse_->age_;
  }
  return number_to_return_if_not_married;
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Prints a value depending on a switch.
/// @param number the number to switch on
void printSomething(int number)
{
  int result = 0;
  switch (number)
  {
    case 0:
      result = 1;
      break;
    default:
      result = MAX_ITEMS;
      break;
  }
  if (result == 1)
    printf("one\n");
  else if (result == MAX_ITEMS)
  {
    printf("ten\n");
  }
  else
  {
    printf("other\n");
  }
  do
  {
    result--;
  } while (result > 0);
  int array[] = {1, 0, 1, 0};
  printf("%d %d\n", array[0], result);
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Allocates an array and frees it again.
/// @return 0 on success, 1 if there is not enough memory
int allocateSomething(void)
{
  char* my_string = (char*)malloc(MAX_ITEMS * sizeof(char));
  if (my_string == NULL)
  {
    return 1;
  }
  int* my_array = malloc(MAX_ITEMS * sizeof(int));
  if (my_array == NULL)
  {
    free(my_string);
    return 1;
  }
  int* temporary_array = (int*)realloc(my_array, MAX_ITEMS * sizeof(int));
  if (temporary_array == NULL)
  {
    free(my_array);
    free(my_string);
    return 1;
  }
  my_array = temporary_array;
  FILE* file = fopen("example.txt", "r");
  if (file == NULL)
  {
    free(my_array);
    free(my_string);
    return 1;
  }
  fclose(file);
  free(my_string);
  free(my_array);
  return 0;
}

//----------------------------------------------------------------------------------------------------------------------
/// @brief Entry point of the program.
/// @return always 0
int main(void)
{
  double area = PI * RADIUS * RADIUS;
  printf("Area: %.2f\n", area);
  printSomething(MAX_ITEMS);
  for (int item_index = 0; item_index < MAX_ITEMS; item_index++)
  {
    printf("%d\n", -item_index);
  }
  return allocateSomething();
}
